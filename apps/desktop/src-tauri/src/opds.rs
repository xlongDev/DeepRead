//! OPDS 书源(plan B9.2):Atom 目录解析 + 下载进现有导入管线。
//!
//! webview 拿到的永远是解析过的目录项与下载好的本地文件路径:URL 与
//! 可选的 Basic 认证都留在 Rust 侧。解析用 quick-xml 按局部名匹配 ——
//! 与 cloud.rs 的 WebDAV multistatus 同一套惯用法,命名空间前缀一视同仁。
//! v1 覆盖 OPDS 1.2(Atom;绝大多数书源);OPDS 2(JSON)不在本批。
//! 分页支持 next 链接;OpenSearch 检索模板未做(多数书源不给模板也能翻页)。

use std::time::Duration;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ai::data_dir;
use crate::error::{AppError, ErrorCode};

/// 目录响应上限:正常目录几百 KB,4MB 已经是异常大的门户首页。
pub const MAX_CATALOG_BYTES: usize = 4 * 1024 * 1024;
/// 单本下载上限:超出的不是电子书,是陷阱。
pub const MAX_BOOK_BYTES: u64 = 512 * 1024 * 1024;
/// 简介截断:目录列表里只需要一句话,超长的条目不拖垮整个面板。
const MAX_SUMMARY_CHARS: usize = 2000;

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OpdsAcquisition {
    pub href: String,
    /// 目录报的 MIME(application/epub+zip 等);缺省时由扩展名兜底。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OpdsEntry {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_url: Option<String>,
    pub downloads: Vec<OpdsAcquisition>,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OpdsCatalog {
    pub title: String,
    pub entries: Vec<OpdsEntry>,
    /// `<link rel="next">`:翻页地址;没有 = 已经是最后一页。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_url: Option<String>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct OpdsFetchRequest {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct OpdsDownloadRequest {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OpdsDownloadResponse {
    /// 落盘文件的绝对路径;上层拿它走 `library.import`。
    pub path: String,
}

/// URL 与 content-type 猜扩展名:URL 路径里的扩展名优先,类型兜底。
/// 猜不出回 "bin" —— library.import 的 detect_format 会给出真实的格式判断。
pub fn extension_for(url: &str, content_type: Option<&str>) -> String {
    let from_url = url
        .split(['?', '#'])
        .next()
        .and_then(|path| path.rsplit('/').next())
        .and_then(|name| name.rsplit('.').next())
        .filter(|ext| {
            matches!(
                *ext,
                "epub" | "mobi" | "azw3" | "pdf" | "fb2" | "cbz" | "txt" | "md"
            )
        })
        .map(str::to_string);
    if let Some(ext) = from_url {
        return ext;
    }
    match content_type
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
    {
        "application/epub+zip" => "epub".into(),
        "application/x-mobipocket-ebook" => "mobi".into(),
        "application/vnd.amazon.ebook" => "azw3".into(),
        "application/pdf" => "pdf".into(),
        "application/fb2+zip" | "application/x-fictionbook+xml" => "fb2".into(),
        "application/vnd.comicbook+zip" | "application/x-cbz" => "cbz".into(),
        "text/plain" => "txt".into(),
        _ => "bin".into(),
    }
}

/// 解析中的条目草稿:字段落账前先攒在这里。
#[derive(Default)]
struct EntryDraft {
    title: String,
    author: Option<String>,
    summary: Option<String>,
    cover: Option<String>,
    downloads: Vec<OpdsAcquisition>,
}

/// 吸收一条 `<link>` 的属性:acquisition 进下载列表,首个 image 进封面,
/// feed 级 next 进翻页地址。rel 匹配用 contains —— 有些目录写全 URI,有些
/// 写短形式,两者都该活。
fn handle_link(
    tag: &quick_xml::events::BytesStart,
    in_entry: bool,
    current: &mut Option<EntryDraft>,
    catalog: &mut OpdsCatalog,
) {
    let mut rel = String::new();
    let mut href = String::new();
    let mut kind: Option<String> = None;
    for attr in tag.attributes().flatten() {
        let key = attr.key.local_name().as_ref().to_string();
        let value = attr.value.to_string();
        match key.as_str() {
            "rel" => rel = value,
            "href" => href = value,
            "type" => kind = Some(value),
            _ => {}
        }
    }
    if rel.contains("acquisition") && in_entry && !href.is_empty() {
        if let Some(draft) = current.as_mut() {
            draft.downloads.push(OpdsAcquisition { href, kind });
        }
    } else if rel.contains("image") && in_entry && !href.is_empty() {
        if let Some(draft) = current.as_mut()
            && draft.cover.is_none()
        {
            draft.cover = Some(href);
        }
    } else if rel == "next" && !href.is_empty() && current.is_none() {
        catalog.next_url = Some(href);
    }
}

/// 解析 OPDS 1.2(Atom)目录:命名空间无关,前缀/默认命名空间一视同仁。
/// 结构坏了不假装成功 —— title 与 entries 双空时由调用方报错。
pub fn parse_opds_catalog(xml: &str) -> OpdsCatalog {
    use quick_xml::events::Event;

    let mut catalog = OpdsCatalog {
        title: String::new(),
        entries: Vec::new(),
        next_url: None,
    };
    let mut path: Vec<String> = Vec::new();
    let mut current: Option<EntryDraft> = None;
    // 累积模型与 cloud.rs 相同:Start 开缓冲,Text/实体/CData 各是同一段
    // 内容的一块,End 落账。
    let mut buffer: Option<String> = None;
    let mut capture = String::new(); // 当前缓冲对应的局部名

    let mut reader = quick_xml::Reader::from_str(xml);
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag)) => {
                let name = tag.local_name().as_ref().to_string();
                if name == "link" {
                    handle_link(
                        &tag,
                        path.iter().any(|p| p == "entry"),
                        &mut current,
                        &mut catalog,
                    );
                }
                if name == "entry" && !path.iter().any(|p| p == "entry") {
                    current = Some(EntryDraft::default());
                } else if current.is_some()
                    && matches!(name.as_str(), "title" | "summary" | "content" | "name")
                {
                    buffer = Some(String::new());
                    capture = name.clone();
                }
                path.push(name);
            }
            // link 是自闭合标签的主要住户:Empty 只抓属性,不进路径栈。
            Ok(Event::Empty(tag)) => {
                if tag.local_name().as_ref() == "link" {
                    handle_link(
                        &tag,
                        path.iter().any(|p| p == "entry"),
                        &mut current,
                        &mut catalog,
                    );
                }
            }
            Ok(Event::Text(text)) => {
                if let Some(buf) = buffer.as_mut() {
                    buf.push_str(&text.xml10_content());
                }
            }
            Ok(Event::GeneralRef(reference)) => {
                let name = reference.as_ref().to_owned();
                let decoded = quick_xml::escape::unescape(&format!("&{name};"))
                    .map(|decoded| decoded.into_owned());
                if let Some(buf) = buffer.as_mut() {
                    buf.push_str(&decoded.unwrap_or_else(|_| format!("&{name};")));
                }
            }
            Ok(Event::CData(text)) => {
                if let Some(buf) = buffer.as_mut() {
                    buf.push_str(text.as_ref());
                }
            }
            Ok(Event::End(tag)) => {
                let name = tag.local_name().as_ref().to_string();
                if name == capture {
                    if let (Some(buf), Some(draft)) = (buffer.take(), current.as_mut()) {
                        let text = buf.trim().to_string();
                        match capture.as_str() {
                            "title" => draft.title = text,
                            "name" => draft.author = Some(text),
                            "summary" | "content"
                                // 先到先得:summary 是展示首选,content(html)兜底。
                                if draft.summary.is_none() => {
                                    draft.summary =
                                        Some(text.chars().take(MAX_SUMMARY_CHARS).collect());
                                }
                            _ => {}
                        }
                    }
                    capture.clear();
                }
                if name == "entry"
                    && let Some(draft) = current.take()
                {
                    catalog.entries.push(OpdsEntry {
                        title: draft.title,
                        author: draft.author,
                        summary: draft.summary,
                        cover_url: draft.cover,
                        downloads: draft.downloads,
                    });
                }
                path.pop();
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    // feed 级标题:第一个 entry 之前出现在 path=[feed] 的 title 已随
    // capture 落进 current —— 但 current 是 entry 专属,feed title 要
    // 单独兜:这里直接扫一遍开头的 <feed><title>。
    if catalog.title.is_empty() {
        catalog.title = feed_title(xml).unwrap_or_default();
    }
    catalog
}

/// feed 级标题:开头的 `<feed><title>文本</title>`,命名空间无关。
fn feed_title(xml: &str) -> Option<String> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut depth = 0usize;
    let mut in_title = false;
    let mut out = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag)) => {
                let name = tag.local_name().as_ref().to_string();
                if name == "title" && depth == 1 {
                    in_title = true;
                    out.clear();
                } else if in_title {
                    // title 里不许嵌套,遇到了就当文本结束。
                    in_title = false;
                }
                depth += 1;
            }
            Ok(Event::Text(text)) if in_title => out.push_str(&text.xml10_content()),
            Ok(Event::GeneralRef(reference)) if in_title => {
                let name = reference.as_ref().to_owned();
                let decoded = quick_xml::escape::unescape(&format!("&{name};"))
                    .map(|decoded| decoded.into_owned());
                out.push_str(&decoded.unwrap_or_else(|_| format!("&{name};")));
            }
            Ok(Event::End(tag)) => {
                if in_title && tag.local_name().as_ref() == "title" {
                    let trimmed = out.trim().to_string();
                    return if trimmed.is_empty() {
                        None
                    } else {
                        Some(trimmed)
                    };
                }
                depth = depth.saturating_sub(1);
            }
            Ok(Event::Eof) => return None,
            Err(_) => return None,
            _ => {}
        }
    }
}

#[tauri::command(rename = "opds.fetch")]
pub async fn opds_fetch(request: OpdsFetchRequest) -> Result<OpdsCatalog, AppError> {
    if request.url.trim().is_empty() {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            "书源地址不能为空",
        ));
    }
    let client = crate::http();
    let mut call = client
        .get(&request.url)
        .timeout(Duration::from_secs(15))
        .header(
            "Accept",
            "application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
        );
    if let Some(username) = request.username.as_deref().filter(|u| !u.trim().is_empty()) {
        call = call.basic_auth(username, request.password.as_deref());
    }
    let response = call.send().await.map_err(|err| {
        AppError::new(ErrorCode::SystemIpcFailed, "无法连接书源。请确认地址可直连").with_cause(err)
    })?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(AppError::new(
            ErrorCode::SystemIpcFailed,
            if status.as_u16() == 401 {
                "书源要求登录(401):请填写账户与密码".to_string()
            } else {
                format!("书源返回 HTTP {status}")
            },
        ));
    }
    let text = response.text().await.map_err(|err| {
        AppError::new(ErrorCode::SystemIpcFailed, "书源响应传输中断").with_cause(err)
    })?;
    if text.len() > MAX_CATALOG_BYTES {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            "书源目录过大,不是一份 OPDS 目录",
        ));
    }
    let catalog = parse_opds_catalog(&text);
    if catalog.title.is_empty() && catalog.entries.is_empty() {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            "响应不是有效的 OPDS 目录(需要 Atom 格式的 OPDS 1.2)",
        ));
    }
    Ok(catalog)
}

#[tauri::command(rename = "opds.download")]
pub async fn opds_download(
    app: tauri::AppHandle,
    request: OpdsDownloadRequest,
) -> Result<OpdsDownloadResponse, AppError> {
    if request.url.trim().is_empty() {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            "下载地址不能为空",
        ));
    }
    let client = crate::http();
    let mut call = client.get(&request.url).timeout(Duration::from_secs(15));
    if let Some(username) = request.username.as_deref().filter(|u| !u.trim().is_empty()) {
        call = call.basic_auth(username, request.password.as_deref());
    }
    let response = call
        .send()
        .await
        .map_err(|err| AppError::new(ErrorCode::SystemIpcFailed, "无法连接书源").with_cause(err))?;
    if !response.status().is_success() {
        return Err(AppError::new(
            ErrorCode::SystemIpcFailed,
            format!("下载返回 HTTP {}", response.status()),
        ));
    }
    if let Some(length) = response.content_length()
        && length > MAX_BOOK_BYTES
    {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            format!(
                "文件超过 {} MB 上限,不是电子书",
                MAX_BOOK_BYTES / (1024 * 1024)
            ),
        ));
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let bytes = response
        .bytes()
        .await
        .map_err(|err| AppError::new(ErrorCode::SystemIpcFailed, "下载传输中断").with_cause(err))?;
    if bytes.len() as u64 > MAX_BOOK_BYTES {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            "文件超过大小上限,不是电子书",
        ));
    }

    let dir = data_dir(&app)?.join("opds-downloads");
    std::fs::create_dir_all(&dir)
        .map_err(|err| AppError::new(ErrorCode::StorageIo, "无法创建下载目录").with_cause(err))?;
    let extension = extension_for(&request.url, content_type.as_deref());
    let stem = url_stem(&request.url)
        .unwrap_or_else(|| format!("book-{}", crate::timestamps::rfc3339_now().replace(':', "")));
    let file_name = format!("{stem}.{extension}");
    let path = dir.join(file_name);
    // Temp + rename:写一半的文件绝不能当成导入原料。
    let temp = path.with_extension("part");
    std::fs::write(&temp, &bytes)
        .map_err(|err| AppError::new(ErrorCode::StorageIo, "下载写盘失败").with_cause(err))?;
    std::fs::rename(&temp, &path)
        .map_err(|err| AppError::new(ErrorCode::StorageIo, "下载提交失败").with_cause(err))?;
    Ok(OpdsDownloadResponse {
        path: path.to_string_lossy().to_string(),
    })
}

/// URL 路径里最后一个文件名段(去扩展名),仅取安全字符。
fn url_stem(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next()?;
    let name = path.rsplit('/').next()?;
    let stem = name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(name);
    let cleaned: String = stem
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(80)
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <id>urn:uuid:catalog</id>
      <title>夜航书源</title>
      <updated>2026-11-18T00:00:00Z</updated>
      <link rel="next" href="/catalog?page=2"/>
      <entry>
        <title>夜航书</title>
        <author><name>北岛</name></author>
        <summary>诗集 &amp; 随笔。</summary>
        <link rel="http://opds-spec.org/image" href="/covers/night.jpg"/>
        <link rel="http://opds-spec.org/acquisition" href="/files/night.epub" type="application/epub+zip"/>
        <link rel="http://opds-spec.org/acquisition" href="/files/night.mobi" type="application/x-mobipocket-ebook"/>
        <content type="text/html">内嵌 &lt;b&gt;HTML&lt;/b&gt; 简介</content>
      </entry>
      <entry>
        <title>灯塔</title>
        <link rel="http://opds-spec.org/acquisition" href="/files/lighthouse.pdf" type="application/pdf"/>
      </entry>
    </feed>"#;

    #[test]
    fn catalog_parses_entries_links_and_next_page() {
        let catalog = parse_opds_catalog(SAMPLE);
        assert_eq!(catalog.title, "夜航书源");
        assert_eq!(catalog.next_url.as_deref(), Some("/catalog?page=2"));
        assert_eq!(catalog.entries.len(), 2);
        let first = &catalog.entries[0];
        assert_eq!(first.title, "夜航书");
        assert_eq!(first.author.as_deref(), Some("北岛"));
        assert_eq!(first.summary.as_deref(), Some("诗集 & 随笔。"));
        assert_eq!(first.cover_url.as_deref(), Some("/covers/night.jpg"));
        assert_eq!(first.downloads.len(), 2);
        assert_eq!(first.downloads[0].href, "/files/night.epub");
        assert_eq!(
            first.downloads[0].kind.as_deref(),
            Some("application/epub+zip")
        );
        // summary 优先,content(html 变体)只在缺失时兜底。
        assert_eq!(first.summary.as_deref(), Some("诗集 & 随笔。"));
        // 无作者无摘要的条目如实为 None,不是空串。
        assert_eq!(catalog.entries[1].author, None);
        assert_eq!(catalog.entries[1].downloads.len(), 1);
    }

    #[test]
    fn malformed_xml_does_not_panic_and_reports_empty() {
        let catalog = parse_opds_catalog("<feed><title>残缺</title><entry><title>");
        // 解析器吃掉能吃的;上层按「title 与 entries 双空」报错,这里 title
        // 可能已捕获,entries 必为空 —— 语义由 opds_fetch 的校验兜住。
        assert!(catalog.entries.is_empty());
    }

    #[test]
    fn extension_prefers_url_then_content_type() {
        assert_eq!(extension_for("/files/a/book.epub?token=1", None), "epub");
        assert_eq!(
            extension_for(
                "/download?id=1",
                Some("application/epub+zip; charset=utf-8")
            ),
            "epub"
        );
        assert_eq!(extension_for("/download?id=1", None), "bin");
    }

    #[test]
    fn url_stem_strips_extension_and_unsafe_chars() {
        assert_eq!(
            url_stem("https://x/files/夜航书.epub?token=1"),
            Some("夜航书".to_string())
        );
        assert_eq!(url_stem("https://x/d/a b/c?d"), Some("c".to_string()));
        assert_eq!(url_stem("https://x/"), None);
    }

    #[test]
    fn download_request_rejects_unknown_fields() {
        let raw = serde_json::json!({ "url": "https://x/book.epub", "extra": 1 });
        assert!(serde_json::from_value::<OpdsDownloadRequest>(raw).is_err());
        let ok = serde_json::json!({ "url": "https://x/book.epub" });
        assert!(serde_json::from_value::<OpdsDownloadRequest>(ok).is_ok());
    }
}
