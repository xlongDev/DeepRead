//! 开发模式的进程指标(plan B9.4)。
//!
//! 调用方(DevStatsOverlay)只在 dev 构建渲染,生产树摇掉;这里保留解析
//! 纯函数与测试。指标经 `ps -o rss=,pcpu=` 一次拿齐 —— 标准库没有进程
//! 指标 API,spawn 一个 ps 是不引 sysinfo 之类依赖的代价(dev-only 可接受)。
//! Windows 返回 None 字段,overlay 相应隐藏行。

use serde::Serialize;
use ts_rs::TS;

use crate::error::{AppError, ErrorCode};

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DevProcessStats {
    /// 进程常驻内存(字节)。拿不到 = None。
    pub rss_bytes: Option<f64>,
    /// 进程 CPU 百分比(ps 口径,可能瞬时 >100 多线程)。拿不到 = None。
    pub cpu_percent: Option<f64>,
}

/// 解析 `ps -o rss=,pcpu=` 的输出:最后一行非空数据 = RSS(KB) + CPU%。
pub fn parse_ps_stats(output: &str) -> Option<(f64, f64)> {
    let line = output.lines().rfind(|line| !line.trim().is_empty())?;
    let mut parts = line.split_whitespace();
    let rss_kb = parts.next()?.parse::<f64>().ok()?;
    let cpu = parts.next()?.parse::<f64>().ok()?;
    Some((rss_kb * 1024.0, cpu))
}

/// `dev.process.stats` — 指标拿不到时字段为 None,不报错:overlay 对缺失
/// 行的策略是隐藏,而不是把开发工具变成一个报错发生器。
#[tauri::command(rename = "dev.process.stats")]
pub fn dev_process_stats() -> Result<DevProcessStats, AppError> {
    #[cfg(unix)]
    {
        let output = std::process::Command::new("ps")
            .args(["-o", "rss=,pcpu=", "-p", &std::process::id().to_string()])
            .output()
            .map_err(|err| {
                AppError::new(ErrorCode::SystemValidation, "ps 不可用").with_cause(err)
            })?;
        let stats = parse_ps_stats(&String::from_utf8_lossy(&output.stdout));
        Ok(match stats {
            Some((rss, cpu)) => DevProcessStats {
                rss_bytes: Some(rss),
                cpu_percent: Some(cpu),
            },
            None => DevProcessStats {
                rss_bytes: None,
                cpu_percent: None,
            },
        })
    }
    #[cfg(not(unix))]
    {
        Ok(DevProcessStats {
            rss_bytes: None,
            cpu_percent: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ps_output_parses_to_bytes_and_percent() {
        assert_eq!(parse_ps_stats(" 8123 4.2 "), Some((8123.0 * 1024.0, 4.2)));
        // 多行输出取最后一行(表头/告警都容忍)。
        assert_eq!(
            parse_ps_stats("warning: something\n 4096 0.0"),
            Some((4096.0 * 1024.0, 0.0))
        );
        assert_eq!(parse_ps_stats(""), None);
        assert_eq!(parse_ps_stats("8123"), None);
        assert_eq!(parse_ps_stats("abc def"), None);
    }
}
