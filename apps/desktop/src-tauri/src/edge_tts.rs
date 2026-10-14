//! Edge TTS (Microsoft Edge read-aloud) with the shared on-disk cache.
//!
//! Speaks through the same WebSocket endpoint the Edge browser uses, gated by
//! the public trusted-client token plus the time-derived `Sec-MS-GEC` proof.
//! Audio arrives as MP3 frames over binary WebSocket messages; word timings
//! arrive as `audio.metadata` text frames beside them. Both are cached under
//! `tts-cache/` — the audio as `{hash}.mp3`, the timings as a `{hash}.words.json`
//! sidecar — so a cache hit still answers with the position the reader's
//! highlight needs.
//!
//! No `rate` reaches the service: every utterance is synthesised once at 1.0 and
//! stretched at playout, which is why the speed is not part of the cache key
//! and changing it costs no request. See `features/reader/tts/edge.ts`.
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

use crate::error::{AppError, ErrorCode};

pub const TRUSTED_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WSS_ENDPOINT: &str =
    "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const VOICES_ENDPOINT: &str = "https://speech.platform.bing.com/consumer/speech/voices/list";
/// v2:服务端已切换到 `2-` 前缀的 GEC 方案,`1-` + 纯 SHA-256 令牌一律 403。
const SEC_MS_GEC_VERSION: &str = "2-143.0.3650.75";
/// Output format: 24 kHz mono MP3 keeps segments small while staying clear.
const AUDIO_FORMAT: &str = "audio-24khz-48kbitrate-mono-mp3";
/// The service reports offsets in 100-nanosecond ticks.
const TICKS_PER_SECOND: f64 = 10_000_000.0;

/// `Sec-MS-GEC` v2 令牌:`<16 位 cs64>-<64 位 sha256>`。
///
/// v1(纯 SHA-256 十六进制)已被服务端整套判 403,换成这个复合 digest:一个把
/// 令牌材料前 7 字节折进初态的改版 SHA-256,外加一个以该 digest 为密钥的
/// CS64 混合。逐行对照 rany2/edge-tts master 的 `drm.py` 移植,行为由
/// `sec_ms_gec_matches_the_reference_vectors` 锁定。tick 取整到 5 分钟桶,
/// 同一桶内令牌不变。
pub fn sec_ms_gec(now_seconds: u64) -> String {
    const WIN_EPOCH_OFFSET: u64 = 11_644_473_600;
    let mut ticks = now_seconds.saturating_add(WIN_EPOCH_OFFSET);
    ticks -= ticks % 300;
    let material = format!("{}{}", ticks * 10_000_000, TRUSTED_CLIENT_TOKEN);
    let data = material.as_bytes();
    let digest = sha256_digest(data);
    let (cs_first, cs_second) = cs64_digest(data, &digest);
    let mut cs64 = [0u8; 8];
    cs64[..4].copy_from_slice(&cs_first.to_le_bytes());
    cs64[4..].copy_from_slice(&cs_second.to_le_bytes());
    format!("{}-{}", hex_upper(&cs64), hex_upper(&digest))
}

/* -------------------------------------------------------------------------- */
/* Sec-MS-GEC v2 digest(对照 rany2/edge-tts master drm.py)                     */
/* -------------------------------------------------------------------------- */

/// 标准 SHA-256 轮常数,除 [14] 被换掉 —— 初态构造只用到前 14+ 轮。
const SHA256_ROUND_CONSTANTS: [u32; 64] = [
    0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
    0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
    0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
    0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
    0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
    0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
    0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
    0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
];
/// 初态构造用的替换轮常数(K[14] 换成它)。
const SHA256_ADJUSTMENT: u32 = 0xC9DC06A7;
const SHA256_BLOCK_CONSTANTS: [u32; 64] = {
    let mut constants = SHA256_ROUND_CONSTANTS;
    constants[14] = SHA256_ADJUSTMENT;
    constants
};
const SHA256_INITIAL: [u32; 8] = [
    0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19,
];
/// 压缩函数的起始寄存器(不是标准 IV)。
const SHA256_STATE: [u32; 8] = [
    0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A, 0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2,
];
/// 初态构造里补 W[16..30] 用的固定调度表。
const SHA256_SCHEDULE: [u32; 14] = [
    0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA, 0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6,
    0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33, 0xD258B060, 0x72766564,
];
const SHA256_SIGMA0_ADJUSTMENT: u32 = 0x059C0B80;
const SHA256_SIGMA1_ADJUSTMENT: u32 = 0x000B92C0;
const CS64_COEFFICIENTS: [(u32, u32); 14] = [
    (0xE82E91B1, 0xB32700D0),
    (0x44DE24C6, 0x88DFF51D),
    (0x3BEB65BC, 0x29514038),
    (0xC89C5933, 0xB328CBDF),
    (0x8D1EC211, 0xD405B4D5),
    (0x314EF5D5, 0x26E55F3C),
    (0xE92491B1, 0x607801C6),
    (0xF0A5B9D5, 0x82B2C1FB),
    (0x06064CF3, 0xFA51A3DA),
    (0xDA79FA60, 0x207CC464),
    (0xBED20560, 0x3C3C74F3),
    (0x89F9C9F8, 0xD2D14B61),
    (0x35FA38C6, 0xBB04A2C1),
    (0xCB49E3C6, 0xC5626167),
];
const CS64_FACTOR: u32 = 0x82893933;
const CS64_ADJUSTMENT0: u32 = 0xF2F90B1A;
const CS64_ADJUSTMENT1: u32 = 0x0B1A0000;

fn rol16(value: u32) -> u32 {
    value.rotate_left(16)
}

/// SHA-256 小 σ。参照实现先移位异或再统一掩码;u32 移位天然截断,逐位等价。
fn small_sigma0(value: u32) -> u32 {
    (value >> 7) ^ (value << 25) ^ (value >> 18) ^ (value << 14) ^ (value >> 3)
}

fn small_sigma1(value: u32) -> u32 {
    (value >> 17) ^ (value << 15) ^ (value >> 19) ^ (value << 13) ^ (value >> 10)
}

/// SHA-256 大 Σ0(作用在 a)。
fn big_sigma0(value: u32) -> u32 {
    value.rotate_right(2) ^ value.rotate_right(13) ^ value.rotate_right(22)
}

/// SHA-256 大 Σ1(作用在 e)。
fn big_sigma1(value: u32) -> u32 {
    value.rotate_right(6) ^ value.rotate_right(11) ^ value.rotate_right(25)
}

/// 消息调度扩展:`W[i] = σ1(W[i-2]) + W[i-7] + σ0(W[i-15]) + W[i-16]`。
/// Python 参照实现是「移位不掩码、求和后再掩码」;模 2^32 加法可逐项截断。
fn expand_schedule(words: &mut Vec<u32>, first_word: usize) {
    for index in first_word..64 {
        let sigma1 = small_sigma1(words[index - 2]);
        let sigma0 = small_sigma0(words[index - 15]);
        words.push(
            sigma1
                .wrapping_add(words[index - 7])
                .wrapping_add(sigma0)
                .wrapping_add(words[index - 16]),
        );
    }
}

/// 64 轮压缩。参照实现把 8 轮一组展开做寄存器轮换(纯优化),数学上与逐轮
/// 标准递推一致 —— 这里取逐轮形式,等价性由测试向量锁定。
fn sha256_rounds(state: [u32; 8], words: &[u32], first_round: usize) -> [u32; 8] {
    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
    let constants: &[u32; 64] = if first_round == 14 {
        &SHA256_BLOCK_CONSTANTS
    } else {
        &SHA256_ROUND_CONSTANTS
    };
    for index in first_round..64 {
        let t1 = h
            .wrapping_add(big_sigma1(e))
            .wrapping_add(g ^ (e & (f ^ g)))
            .wrapping_add(constants[index])
            .wrapping_add(words[index]);
        let t2 = big_sigma0(a).wrapping_add((a & b) | (c & (a | b)));
        h = g;
        g = f;
        f = e;
        e = d.wrapping_add(t1);
        d = c;
        c = b;
        b = a;
        a = t1.wrapping_add(t2);
    }
    [a, b, c, d, e, f, g, h]
}

/// 把材料前 7 字节折进压缩初态:14 个零字 + 前 3 字 + 后 4 字,再用固定调度
/// 表补出 W[16..30](第 16/29 字各带一处异或修正),W[30] 是特调混合项。
fn sha256_init(data: &[u8]) -> [u32; 8] {
    let mut words = vec![0u32; 14];
    words.push(u32::from_be_bytes([0, data[0], data[1], data[2]]));
    words.push(u32::from_be_bytes([data[3], data[4], data[5], data[6]]));
    for index in 16..30 {
        let mut value = SHA256_SCHEDULE[index - 16];
        let sigma1 = small_sigma1(words[index - 2]);
        value = value.wrapping_add(if index == 16 {
            sigma1 ^ SHA256_SIGMA1_ADJUSTMENT
        } else {
            sigma1
        });
        if index >= 21 {
            value = value.wrapping_add(words[index - 7]);
        }
        if index >= 29 {
            let sigma0 = small_sigma0(words[index - 15]);
            value = value.wrapping_add(if index == 29 {
                sigma0 ^ SHA256_SIGMA0_ADJUSTMENT
            } else {
                sigma0
            });
        }
        words.push(value);
    }
    words.push(
        small_sigma1(words[28])
            .wrapping_add(words[23])
            .wrapping_add(small_sigma0(words[15]))
            .wrapping_add(words[14])
            .wrapping_add(SHA256_ADJUSTMENT)
            .wrapping_sub(SHA256_ROUND_CONSTANTS[14]),
    );
    expand_schedule(&mut words, 31);
    let working = sha256_rounds(SHA256_STATE, &words, 14);
    let mut state = [0u32; 8];
    for (slot, (initial, worked)) in state
        .iter_mut()
        .zip(SHA256_INITIAL.iter().zip(working.iter()))
    {
        *slot = initial.wrapping_add(*worked);
    }
    state
}

/// 改版 SHA-256:前 7 字节进初态,其余字节按 `length = 57 + len(data)` 补位
/// (Python 的 `(55 - length) % 64` 对负数取正余数,这里显式绕回)。
fn sha256_digest(data: &[u8]) -> [u8; 32] {
    debug_assert!(data.len() >= 7, "令牌材料远长于 7 字节");
    let length = 57 + data.len();
    let zeros = (55 + 64 - length % 64) % 64;
    let mut padded = Vec::with_capacity(data.len() + zeros + 10);
    padded.extend_from_slice(&data[7..]);
    padded.push(0x80);
    let target = padded.len() + zeros;
    padded.resize(target, 0);
    padded.extend_from_slice(&((length as u64) * 8).to_be_bytes());
    let mut state = sha256_init(&data[..7]);
    for block in padded.chunks(64) {
        let mut words = Vec::with_capacity(64);
        for word in block.chunks(4) {
            words.push(u32::from_be_bytes([word[0], word[1], word[2], word[3]]));
        }
        expand_schedule(&mut words, 16);
        let working = sha256_rounds(state, &words, 0);
        for index in 0..8 {
            state[index] = state[index].wrapping_add(working[index]);
        }
    }
    let mut digest = [0u8; 32];
    for (index, word) in state.iter().enumerate() {
        digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    digest
}

/// CS64:以 digest 前 8 字节为密钥,把材料搅成两个 u32。
fn cs64_digest(data: &[u8], digest: &[u8; 32]) -> (u32, u32) {
    let key_a = u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]) | 1;
    let key_b = u32::from_le_bytes([digest[4], digest[5], digest[6], digest[7]]) | 1;
    let factors = [
        key_a.wrapping_mul(CS64_FACTOR),
        key_b.wrapping_mul(CS64_FACTOR),
    ];
    let mut terms: Vec<u32> = CS64_COEFFICIENTS
        .iter()
        .enumerate()
        .map(|(index, (coefficient, _))| coefficient.wrapping_mul(factors[index % 2]))
        .collect();
    let mut offsets: Vec<u32> = CS64_COEFFICIENTS
        .iter()
        .map(|(_, offset)| *offset)
        .collect();
    // `\x00` 前缀 + 材料,按 4 字节小端切词,补到偶数个。
    let mut buffer = Vec::with_capacity(1 + data.len() + 3);
    buffer.push(0);
    buffer.extend_from_slice(data);
    let padded_len = buffer.len().div_ceil(4) * 4;
    buffer.resize(padded_len, 0);
    let mut words: Vec<u32> = buffer
        .chunks(4)
        .map(|word| u32::from_le_bytes([word[0], word[1], word[2], word[3]]))
        .collect();
    if words.len() % 2 == 1 {
        words.push(0);
    }
    for (index, word) in words.iter().enumerate() {
        let word = *word;
        let mut term = word.wrapping_mul(if index % 2 == 0 { key_a } else { key_b });
        let mut offset = rol16(word).wrapping_mul(if index % 2 == 0 {
            0xEF05_69FB
        } else {
            0xC317_13DB
        });
        if index == 0 {
            term = term.wrapping_add(CS64_ADJUSTMENT0.wrapping_mul(factors[0]));
            offset = offset.wrapping_add(CS64_ADJUSTMENT1);
        }
        terms.push(term);
        offsets.push(offset);
    }
    let mut swap_acc: u32 = 0;
    let mut swap_last: u32 = 0;
    let mut state: u32 = 0;
    let mut acc: u32 = 0;
    for index in (0..terms.len()).step_by(2) {
        let x = terms[index];
        let y = terms[index + 1];
        let t = rol16(offsets[index].wrapping_add(x));
        let q = t.wrapping_mul(0x76F5_0F34);
        swap_acc = swap_acc.wrapping_add(rol16(q).wrapping_mul(0xC3EF_EA97).wrapping_add(q));
        let t = rol16(offsets[index + 1].wrapping_add(y));
        let q = t.wrapping_mul(0x1881_CE3C);
        swap_last = rol16(q).wrapping_mul(0x35BD_1EC9).wrapping_add(q);
        swap_acc = swap_acc.wrapping_add(swap_last);
        state = state.wrapping_mul(key_a).wrapping_add(x);
        state = rol16(state).wrapping_mul(0xCF98_B111);
        state = rol16(state).wrapping_mul(0x8708_5B9F);
        state = rol16(state).wrapping_mul(0x12CE_B96D);
        state = rol16(state).wrapping_mul(0x257E_1D83);
        acc = acc.wrapping_add(state);
        let mut t = state.wrapping_mul(key_b).wrapping_add(y);
        t = rol16(t).wrapping_mul(0xA274_16F5);
        t = rol16(t).wrapping_mul(0xD383_96FF);
        state = rol16(rol16(t).wrapping_mul(0x7C93_2B89)).wrapping_mul(0xBFA4_9F69);
        acc = acc.wrapping_add(state);
    }
    (swap_last ^ state, swap_acc ^ acc)
}

fn hex_upper(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        // 写进 String 不会失败。
        let _ = write!(out, "{byte:02X}");
    }
    out
}

/// Pure helper: the WebSocket URL with all required query parameters.
pub fn synthesize_url(now_seconds: u64) -> String {
    format!(
        "{WSS_ENDPOINT}?TrustedClientToken={TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC={}&Sec-MS-GEC-Version={SEC_MS_GEC_VERSION}",
        sec_ms_gec(now_seconds)
    )
}

/// Pure helper: SSML for one segment. `rate` 1.0 maps to `+0%`.
pub fn ssml_for(text: &str, voice: &str, lang: &str, rate: f64) -> String {
    let percent = ((rate - 1.0) * 100.0).round();
    let sign = if percent >= 0.0 { '+' } else { '-' };
    let percent = percent.abs();
    let escaped = text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\'', "&apos;")
        .replace('"', "&quot;");
    format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='{lang}'>\
         <voice name='{voice}'>\
         <prosody pitch='+0Hz' rate='{sign}{percent}%'>\
         {escaped}\
         </prosody></voice></speak>"
    )
}

/// Pure helper: the two text frames the protocol expects on connect.
///
/// Word boundaries on, sentence boundaries off: the queue is already
/// sentence-shaped, so a second cue list would only repeat it.
pub fn handshake_messages(ssml: &str, request_id: &str, now_seconds: u64) -> (String, String) {
    let timestamp = rfc1123(now_seconds);
    let config = format!(
        "X-Timestamp:{timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n\
         {{\"context\":{{\"synthesis\":{{\"audio\":{{\"metadataoptions\":{{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"true\"}},\"outputFormat\":\"{AUDIO_FORMAT}\"}}}}}}}}"
    );
    let ssml_frame = format!(
        "X-RequestId:{request_id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{timestamp}Z\r\nPath:ssml\r\n\r\n{ssml}"
    );
    (config, ssml_frame)
}

/// Pure helper: RFC 1123 date (no external chrono dependency needed for this).
pub fn rfc1123(now_seconds: u64) -> String {
    // time crate is already in the dependency tree.
    let offset = time::OffsetDateTime::from_unix_timestamp(now_seconds as i64)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    offset
        .format(&time::format_description::well_known::Rfc2822)
        .unwrap_or_default()
        .replace("+0000", "GMT")
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn request_id() -> String {
    let digest = Sha256::digest(now_seconds().to_le_bytes().as_slice());
    let hex: String = digest.iter().map(|byte| format!("{byte:02X}")).collect();
    hex.chars().take(32).collect()
}

/// 16 个随机字节:进程随机种子 + 时钟 + 计数器一起哈希。连接 ID 与 MUID 只
/// 需要「每次不同」,真正的鉴权是 GEC 令牌,不值得为它们引 rand/uuid。
fn random_id_bytes() -> [u8; 16] {
    use std::hash::{BuildHasher, Hash, Hasher, RandomState};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut bytes = [0u8; 16];
    for chunk in bytes.chunks_mut(8) {
        let mut hasher = RandomState::new().build_hasher();
        now_nanos().hash(&mut hasher);
        COUNTER.fetch_add(1, Ordering::Relaxed).hash(&mut hasher);
        let value = hasher.finish().to_le_bytes();
        chunk.copy_from_slice(&value[..chunk.len()]);
    }
    bytes
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

/// 参照实现的 `uuid4().hex`:小写 32 位,版本/变体位按 RFC 4122 摆好。
fn connection_id() -> String {
    let mut bytes = random_id_bytes();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let mut out = String::with_capacity(32);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// 参照实现的 `secrets.token_hex(16).upper()`:大写 32 位随机十六进制。
fn muid() -> String {
    hex_upper(&random_id_bytes())
}

/* -------------------------------------------------------------------------- */
/* Word timings                                                               */
/* -------------------------------------------------------------------------- */

/// One word the service reports: `at` seconds from the start of the clip.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct EdgeWord {
    pub at: f64,
    pub text: String,
}

/// One synthesized utterance: its MP3 bytes, and where each word sits in them.
#[derive(Debug, Clone, PartialEq)]
pub struct EdgeClip {
    pub audio: Vec<u8>,
    pub words: Vec<EdgeWord>,
}

/// One `key: value` line out of a frame's header block.
fn header_value<'a>(head: &'a str, key: &str) -> Option<&'a str> {
    head.lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case(key))
        .map(|(_, value)| value.trim())
}

/// Splits a frame into its header block and its body.
fn split_frame(raw: &[u8]) -> (&str, &[u8]) {
    let boundary = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|at| at + 4);
    match boundary {
        Some(at) => (
            std::str::from_utf8(&raw[..at]).unwrap_or(""),
            raw.get(at..).unwrap_or_default(),
        ),
        None => (std::str::from_utf8(raw).unwrap_or(""), &[]),
    }
}

/// A binary frame is `[u16 header length][header][audio]`; the length is
/// declared, so the split does not have to search for it.
fn split_binary(raw: &[u8]) -> Option<(&str, &[u8])> {
    let first = *raw.first()?;
    let second = *raw.get(1)?;
    let length = u16::from_be_bytes([first, second]) as usize;
    let head = std::str::from_utf8(raw.get(2..2 + length)?).ok()?;
    Some((head, raw.get(2 + length..)?))
}

/// The service escapes the words it reports back; `&amp;` here is a real `&`.
fn unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

#[derive(Deserialize)]
struct MetadataEnvelope {
    #[serde(rename = "Metadata", default)]
    metadata: Vec<MetadataItem>,
}

#[derive(Deserialize)]
struct MetadataItem {
    #[serde(rename = "Type")]
    kind: String,
    #[serde(rename = "Data", default)]
    data: Option<MetadataData>,
}

#[derive(Deserialize, Default)]
struct MetadataData {
    #[serde(rename = "Offset", default)]
    offset: u64,
    #[serde(rename = "text", default)]
    text: MetadataWord,
}

#[derive(Deserialize, Default)]
struct MetadataWord {
    #[serde(rename = "Text", default)]
    text: String,
}

/// The word timings out of one `audio.metadata` body.
///
/// A body that will not parse is not a failed utterance — the audio is already
/// on its way and the reader would rather hear the sentence without a moving
/// highlight than not hear it at all, so the timings are dropped and warned
/// about instead.
fn parse_words(body: &[u8]) -> Vec<EdgeWord> {
    let envelope: MetadataEnvelope = match serde_json::from_slice(body) {
        Ok(envelope) => envelope,
        Err(err) => {
            log::warn!("edge tts: word timings unreadable: {err}");
            return Vec::new();
        }
    };
    envelope
        .metadata
        .into_iter()
        .filter(|item| item.kind == "WordBoundary")
        // `Data` is absent on the service's own bookkeeping frames
        // (`SessionEnd`), announced through the same channel.
        .filter_map(|item| item.data)
        .map(|data| EdgeWord {
            at: data.offset as f64 / TICKS_PER_SECOND,
            text: unescape(&data.text.text),
        })
        .collect()
}

#[derive(Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EdgeVoice {
    pub short_name: String,
    pub friendly_name: String,
    pub locale: String,
    pub gender: String,
}

/// Fallback catalog when the live voice list is unreachable: the full set of
/// Chinese voices plus the most-used English ones.
fn fallback_voices() -> Vec<EdgeVoice> {
    const ZH: &[&str] = &[
        "zh-CN-XiaoxiaoNeural",
        "zh-CN-XiaoyiNeural",
        "zh-CN-YunjianNeural",
        "zh-CN-YunxiNeural",
        "zh-CN-YunxiaNeural",
        "zh-CN-YunyangNeural",
        "zh-CN-liaoning-XiaobeiNeural",
        "zh-CN-shaanxi-XiaoniNeural",
        "zh-HK-HiuGaaiNeural",
        "zh-HK-HiuMaanNeural",
        "zh-HK-WanLungNeural",
        "zh-TW-HsiaoChenNeural",
        "zh-TW-HsiaoYuNeural",
        "zh-TW-YunJheNeural",
    ];
    const EN: &[&str] = &[
        "en-US-AriaNeural",
        "en-US-AnaNeural",
        "en-US-ChristopherNeural",
        "en-US-EricNeural",
        "en-US-GuyNeural",
        "en-US-JennyNeural",
        "en-MichelleNeural",
        "en-US-RogerNeural",
        "en-US-SteffanNeural",
        "en-GB-SoniaNeural",
        "en-GB-RyanNeural",
        "en-GB-LibbyNeural",
    ];
    let mut voices: Vec<EdgeVoice> = ZH
        .iter()
        .chain(EN.iter())
        .map(|short| {
            let locale = short.split('-').take(2).collect::<Vec<_>>().join("-");
            EdgeVoice {
                short_name: (*short).to_string(),
                friendly_name: (*short).to_string(),
                locale,
                gender: "—".to_string(),
            }
        })
        .collect();
    voices.sort_by(|a, b| a.short_name.cmp(&b.short_name));
    voices
}

/// Live voice list; falls back to the curated catalog on any failure.
pub async fn edge_voices() -> Result<Vec<EdgeVoice>, AppError> {
    let seconds = now_seconds();
    let gec = sec_ms_gec(seconds);
    let url = format!(
        "{VOICES_ENDPOINT}?trustedclienttoken={TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC={gec}&Sec-MS-GEC-Version={SEC_MS_GEC_VERSION}"
    );
    let response = crate::http()
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|err| {
            AppError::new(ErrorCode::TtsProviderError, "无法获取 Edge 语音列表")
                .with_cause(err)
                .retryable()
        })?;
    if !response.status().is_success() {
        return Ok(fallback_voices());
    }
    #[derive(Deserialize)]
    struct RawVoice {
        #[serde(rename = "ShortName")]
        short_name: String,
        #[serde(rename = "FriendlyName")]
        friendly_name: String,
        #[serde(rename = "Locale")]
        locale: String,
        #[serde(rename = "Gender")]
        gender: String,
    }
    let raw: Vec<RawVoice> = response.json().await.map_err(|err| {
        AppError::new(ErrorCode::TtsProviderError, "Edge 语音列表解析失败")
            .with_cause(err)
            .retryable()
    })?;
    let voices: Vec<EdgeVoice> = raw
        .into_iter()
        .map(|voice| EdgeVoice {
            short_name: voice.short_name,
            friendly_name: voice.friendly_name,
            locale: voice.locale,
            gender: voice.gender,
        })
        .collect();
    if voices.is_empty() {
        return Ok(fallback_voices());
    }
    Ok(voices)
}

/// Synthesize one segment over WebSocket: MP3 binary frames plus word timings.
///
/// The turn must end on `turn.end`. A socket that closes first holds a partial
/// clip, and playing that would cut a sentence in half, so it is an error
/// rather than a short read.
async fn synthesize(text: &str, voice: &str, lang: &str) -> Result<EdgeClip, AppError> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let seconds = now_seconds();
    // 参照实现每次连接都带 ConnectionId 与 muid Cookie(内容不校验,只求唯一)。
    let url = format!(
        "{}&ConnectionId={}",
        synthesize_url(seconds),
        connection_id()
    );
    let mut request = url.into_client_request().map_err(|err| {
        AppError::new(ErrorCode::TtsProviderError, "Edge TTS 连接请求构造失败").with_cause(err)
    })?;
    // The endpoint rejects bare upgrades with 403. Headers mirror the Edge
    // read-aloud extension (edge-tts reference): extension Origin, no-cache,
    // and a current Edge browser User-Agent.
    let headers = request.headers_mut();
    for (name, value) in [
        (
            "Origin",
            "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        ),
        ("Pragma", "no-cache"),
        ("Cache-Control", "no-cache"),
        ("Accept-Language", "en-US,en;q=0.9"),
        (
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
        ),
    ] {
        headers.insert(name, value.parse().expect("static header value"));
    }
    let cookie = format!("muid={};", muid());
    headers.insert("Cookie", cookie.parse().expect("hex cookie value"));
    let (mut socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|err| {
            AppError::new(ErrorCode::TtsProviderError, "无法连接 Edge TTS 服务")
                .with_cause(err)
                .retryable()
        })?;

    // Synthesised at 1.0 whatever the reader's speed is: the renderer stretches
    // on the way to the speaker, so one clip serves every rate (see `timeStretch`).
    let (config, ssml_frame) =
        handshake_messages(&ssml_for(text, voice, lang, 1.0), &request_id(), seconds);
    socket.send(Message::Text(config)).await.map_err(|err| {
        AppError::new(ErrorCode::TtsProviderError, "Edge TTS 握手发送失败")
            .with_cause(err)
            .retryable()
    })?;
    socket
        .send(Message::Text(ssml_frame))
        .await
        .map_err(|err| {
            AppError::new(ErrorCode::TtsProviderError, "Edge TTS 请求发送失败")
                .with_cause(err)
                .retryable()
        })?;

    let mut audio: Vec<u8> = Vec::new();
    let mut words: Vec<EdgeWord> = Vec::new();
    let mut ended = false;
    while let Some(message) = socket.next().await {
        let message = message.map_err(|err| {
            AppError::new(ErrorCode::TtsProviderError, "Edge TTS 连接中断")
                .with_cause(err)
                .retryable()
        })?;
        match message {
            Message::Binary(bytes) => {
                let Some((head, payload)) = split_binary(&bytes) else {
                    continue;
                };
                if header_value(head, "Path") == Some("audio") {
                    audio.extend_from_slice(payload);
                }
            }
            Message::Text(frame) => {
                let (head, body) = split_frame(frame.as_bytes());
                match header_value(head, "Path") {
                    Some("audio.metadata") => words.extend(parse_words(body)),
                    Some("turn.end") => {
                        ended = true;
                        break;
                    }
                    _ => {}
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    if !ended {
        return Err(
            AppError::new(ErrorCode::TtsProviderError, "Edge 语音连接在合成途中断开").retryable(),
        );
    }
    if audio.is_empty() {
        return Err(AppError::new(ErrorCode::TtsProviderError, "Edge TTS 未返回音频").retryable());
    }
    Ok(EdgeClip { audio, words })
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct EdgeTtsAudioRequest {
    pub text: String,
    pub voice: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
}

/// One utterance, ready to play: the MP3 as base64, and where each word sits.
///
/// Base64 inside the same payload as the timings rather than a path the
/// renderer fetches on a second call: the two are useless apart, and one round
/// trip per sentence is what keeps the prefetch simple.
#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EdgeTtsAudioResponse {
    pub audio: String,
    pub words: Vec<EdgeWord>,
    pub cached: bool,
}

/// Synthesize-or-serve through the Edge endpoint, cached like cloud audio.
pub async fn edge_tts_audio(
    base: &Path,
    request: EdgeTtsAudioRequest,
) -> Result<EdgeTtsAudioResponse, AppError> {
    let text = request.text.trim().to_string();
    if text.is_empty() {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            "合成文本不能为空",
        ));
    }
    if text.chars().count() > crate::tts::MAX_TTS_TEXT_CHARS {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            "单次合成的文本过长",
        ));
    }
    let voice = request.voice.trim().to_string();
    if voice.is_empty() {
        return Err(AppError::new(ErrorCode::SystemValidation, "语音不能为空"));
    }
    let lang = request
        .lang
        .unwrap_or_else(|| voice.split('-').take(2).collect::<Vec<_>>().join("-"));

    // The speed is not part of the key: every clip is synthesised at 1.0 and
    // stretched at playout, so one cached reading answers every rate.
    let file_name = crate::tts::cache_file_name("edge", &voice, 1.0, &text, "edge-tts");
    let path = crate::tts::cache_dir(base).join(file_name);
    let words_path = path.with_extension("words.json");
    // A hit needs both halves: audio without its timings is a sentence the
    // highlight cannot follow, so a missing sidecar re-synthesises rather than
    // silently degrading to a stale position.
    if let (Ok(bytes), Ok(raw)) = (std::fs::read(&path), std::fs::read_to_string(&words_path)) {
        let words = serde_json::from_str::<Vec<EdgeWord>>(&raw).unwrap_or_default();
        return Ok(EdgeTtsAudioResponse {
            audio: STANDARD.encode(&bytes),
            words,
            cached: true,
        });
    }

    // Edge 端点偶尔掐断连接:失败后换一个时间桶重试一次再报错。
    let clip = match synthesize(&text, &voice, &lang).await {
        Ok(clip) => clip,
        Err(first) => synthesize(&text, &voice, &lang).await.map_err(|_| first)?,
    };
    std::fs::create_dir_all(path.parent().expect("cache path has a parent")).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to create tts cache").with_cause(err)
    })?;
    let temp = path.with_extension("part");
    std::fs::write(&temp, &clip.audio).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to write audio").with_cause(err)
    })?;
    std::fs::rename(&temp, &path).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to commit audio").with_cause(err)
    })?;
    // The sidecar is the only copy of the timings, but a sentence is worth
    // hearing without them — so a failed write is logged and the clip stands.
    match serde_json::to_string(&clip.words) {
        Ok(raw) => {
            if let Err(err) = std::fs::write(&words_path, raw) {
                log::warn!("edge tts: word sidecar not written: {err}");
            }
        }
        Err(err) => log::warn!("edge tts: word timings not serialised: {err}"),
    }
    Ok(EdgeTtsAudioResponse {
        audio: STANDARD.encode(&clip.audio),
        words: clip.words,
        cached: false,
    })
}

#[tauri::command(rename = "tts.edge.audio")]
pub async fn command_edge_tts_audio(
    app: tauri::AppHandle,
    request: EdgeTtsAudioRequest,
) -> Result<EdgeTtsAudioResponse, AppError> {
    let base = crate::ai::data_dir(&app)?;
    edge_tts_audio(&base, request).await
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EdgeVoicesResponse {
    pub voices: Vec<EdgeVoice>,
}

#[tauri::command(rename = "tts.edge.voices")]
pub async fn command_edge_tts_voices() -> Result<EdgeVoicesResponse, AppError> {
    Ok(EdgeVoicesResponse {
        voices: edge_voices().await?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sec_ms_gec_is_deterministic_and_5min_stable() {
        // 1_700_000_100 + WIN_EPOCH lands exactly on a 5-minute boundary.
        let a = sec_ms_gec(1_700_000_100);
        let b = sec_ms_gec(1_700_000_100);
        let c = sec_ms_gec(1_700_000_399); // same 5-minute bucket
        let d = sec_ms_gec(1_700_000_400); // next bucket
        assert_eq!(a, b);
        assert_eq!(a, c);
        assert_ne!(a, d);
        // v2:<16 位 cs64>-<64 位 sha256>,全大写十六进制。
        assert_eq!(a.len(), 81);
        let (cs64, sha) = a.split_once('-').expect("v2 token carries a dash");
        assert_eq!(cs64.len(), 16);
        assert_eq!(sha.len(), 64);
        assert!(
            a.chars()
                .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '-')
        );
    }

    #[test]
    fn sec_ms_gec_matches_the_reference_vectors() {
        // rany2/edge-tts master drm.py 的实测输出(同 5 分钟桶同 token)。
        // 任何一位对不上,说明移植偏了 —— 服务端会安静地回 403。
        assert_eq!(
            sec_ms_gec(1_781_443_200),
            "DA88440AF4EA9A46-9B7042D17292F8C1A6671FED853FA84E858899273A1454285105BB695913EC63"
        );
        assert_eq!(
            sec_ms_gec(1_781_443_456), // 同一桶内 56 秒后
            "DA88440AF4EA9A46-9B7042D17292F8C1A6671FED853FA84E858899273A1454285105BB695913EC63"
        );
        assert_eq!(
            sec_ms_gec(1_781_443_000), // 上一个桶
            "7F271A6F06A973FB-A4350DF85A5D71D8C015C82A10C3CD6397171FB4620763DD03D8E67CFE9CF5A2"
        );
        assert_eq!(
            sec_ms_gec(1_000_000_000),
            "5E9153719FADA922-14D2A75113EC5862E17303287DCDB197E3A671DF9FCC53C100D6B27928384B98"
        );
        assert_eq!(
            sec_ms_gec(0),
            "52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6"
        );
    }

    #[test]
    fn synthesize_url_carries_token_and_proof() {
        let url = synthesize_url(1_700_000_000);
        assert!(url.starts_with(WSS_ENDPOINT));
        assert!(url.contains("TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4"));
        assert!(url.contains("Sec-MS-GEC="));
        assert!(url.contains("Sec-MS-GEC-Version="));
    }

    #[test]
    fn ssml_escapes_and_encodes_rate() {
        let ssml = ssml_for("你好 & <世界>", "zh-CN-XiaoxiaoNeural", "zh-CN", 1.5);
        assert!(ssml.contains("rate='+50%'"));
        assert!(ssml.contains("你好 &amp; &lt;世界&gt;"));
        assert!(ssml.contains("voice name='zh-CN-XiaoxiaoNeural'"));
        let slow = ssml_for("你好", "zh-CN-XiaoxiaoNeural", "zh-CN", 0.75);
        assert!(slow.contains("rate='-25%'"));
    }

    #[test]
    fn handshake_frames_carry_paths() {
        let (config, ssml) = handshake_messages("<speak/>", "ABC123", 1_700_000_000);
        assert!(config.contains("Path:speech.config"));
        assert!(config.contains("outputFormat"));
        assert!(config.contains(r#""wordBoundaryEnabled":"true""#));
        assert!(ssml.contains("X-RequestId:ABC123"));
        assert!(ssml.contains("Path:ssml"));
        assert!(ssml.ends_with("<speak/>"));
    }

    #[test]
    fn word_timings_come_out_of_metadata() {
        // 100ns ticks, and the service's own escaping undone.
        let body = r#"{"Metadata":[{"Type":"WordBoundary","Data":{"Offset":0,"Duration":3000000,"text":{"Text":"你好","Length":2}}},{"Type":"WordBoundary","Data":{"Offset":21375000,"Duration":4000000,"text":{"Text":"一次","Length":2}}},{"Type":"SessionEnd","Data":{}}]}"#;
        let words = parse_words(body.as_bytes());
        assert_eq!(words.len(), 2, "SessionEnd 不是词");
        assert_eq!(words[0].at, 0.0);
        assert_eq!(words[1].text, "一次");
        assert!((words[1].at - 2.1375).abs() < 1e-9);
    }

    #[test]
    fn word_timings_are_unescaped_and_never_fatal() {
        let body = r#"{"Metadata":[{"Type":"WordBoundary","Data":{"Offset":1,"text":{"Text":"a &amp; b &lt;c&gt;"}}}]}"#;
        assert_eq!(parse_words(body.as_bytes())[0].text, "a & b <c>");
        // A body this is not: the utterance still plays, it just loses its wash.
        assert!(parse_words(b"not json").is_empty());
    }

    #[test]
    fn frames_split_on_their_declared_header() {
        let (head, body) = split_frame(b"Path:audio.metadata\r\n\r\n{\"Metadata\":[]}");
        assert_eq!(header_value(head, "Path"), Some("audio.metadata"));
        assert_eq!(body, br#"{"Metadata":[]}"#);
        // [0x00 0x0c] header length, then the header, then the payload.
        let raw = b"\x00\x0cPath:audio\r\nXX";
        let (head, payload) = split_binary(raw).expect("binary frame splits");
        assert_eq!(header_value(head, "Path"), Some("audio"));
        assert_eq!(payload, b"XX");
        assert!(split_binary(b"\x00").is_none());
    }

    /// 真实端到端:连微软端点合成一段中文(需要联网,平时跳过)。
    #[tokio::test]
    #[ignore = "hits the live Edge endpoint; run with --ignored"]
    async fn edge_audio_synthesizes_live() {
        let base = std::env::temp_dir().join("deepread-edge-tts-live");
        let result = edge_tts_audio(
            &base,
            EdgeTtsAudioRequest {
                text: "你好,这是深读的语音合成测试。".to_string(),
                voice: "zh-CN-XiaoxiaoNeural".to_string(),
                lang: Some("zh-CN".to_string()),
            },
        )
        .await
        .expect("live synthesis should succeed");
        let bytes = STANDARD.decode(&result.audio).expect("base64 audio");
        assert!(bytes.len() > 10_000, "mp3 too small: {}", bytes.len());
        // Edge returns a raw MPEG stream: frame sync 0xFFF (no ID3 header).
        assert_eq!(bytes[0], 0xFF, "should start with an MPEG frame sync");
        assert_eq!(bytes[1] & 0xE0, 0xE0, "sync bits + version must be set");
        assert!(!result.words.is_empty(), "没有词边界");
        assert!(
            result.words.windows(2).all(|pair| pair[0].at <= pair[1].at),
            "词边界必须单调"
        );
    }

    #[tokio::test]
    async fn edge_audio_rejects_bad_input() {
        let base = std::env::temp_dir().join("deepread-edge-tts-test");
        let empty = edge_tts_audio(
            &base,
            EdgeTtsAudioRequest {
                text: "  ".to_string(),
                voice: "zh-CN-XiaoxiaoNeural".to_string(),
                lang: None,
            },
        )
        .await;
        assert!(empty.is_err());
        let no_voice = edge_tts_audio(
            &base,
            EdgeTtsAudioRequest {
                text: "你好".to_string(),
                voice: "  ".to_string(),
                lang: None,
            },
        )
        .await;
        assert!(no_voice.is_err());
    }
}
