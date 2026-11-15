//! Local files: which ones may be uploaded, and how results are saved.
use std::{env, fs, io::Write, path::PathBuf};

use base64::prelude::*;

use crate::gateway::{HyadesError, Result};

const MAX_UPLOAD_BYTES: u64 = 20 * 1024 * 1024;
const PNG_SIGNATURE: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

pub fn sniff_image(buf: &[u8]) -> Option<&'static str> {
    if buf.starts_with(PNG_SIGNATURE) {
        Some("image/png")
    } else if buf.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if buf.len() >= 12 && &buf[0..4] == b"RIFF" && &buf[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

pub fn image_ext(mime: Option<&str>) -> &'static str {
    match mime {
        Some("image/jpeg") => ".jpg",
        Some("image/webp") => ".webp",
        _ => ".png",
    }
}

// Every tool argument that names a local file is uploaded to the gateway. Only real image content
// may leave the machine, so a prompt-injected path such as ~/.ssh/id_rsa or .env is refused before
// any request is made. The type comes from the bytes, never from the file extension.
pub fn image_data_url(path: &str, field: &str) -> Result<String> {
    let meta = fs::metadata(path).map_err(|_| HyadesError::new("bad_args", format!("{field} does not exist: {path}")))?;
    if !meta.is_file() {
        return Err(HyadesError::new("bad_args", format!("{field} is not a regular file: {path}")));
    }
    if meta.len() > MAX_UPLOAD_BYTES {
        return Err(HyadesError::new("bad_args", format!("{field} is larger than 20 MB: {path}")));
    }
    let buf = fs::read(path).map_err(|e| HyadesError::new("bad_args", format!("{field} could not be read: {e}")))?;
    let mime = sniff_image(&buf).ok_or_else(|| HyadesError::new("bad_args", format!("{field} is not a PNG, JPEG or WebP image: {path}")))?;
    Ok(format!("data:{mime};base64,{}", BASE64_STANDARD.encode(&buf)))
}

// Result URLs are temporary, so results are written to disk before the tool returns. `create_new`
// makes writing fail rather than replace an existing file; on a name clash we pick another.
pub fn write_unique(buf: &[u8], prefix: &str, ext: &str) -> Result<String> {
    let out_dir = env::var_os("HYADES_OUTPUT_DIR").map(PathBuf::from).unwrap_or_else(|| env::current_dir().unwrap_or_default());
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    loop {
        let mut suffix = [0u8; 3];
        getrandom::fill(&mut suffix).map_err(|e| HyadesError::new("internal", format!("random suffix: {e}")))?;
        let hex: String = suffix.iter().map(|b| format!("{b:02x}")).collect();
        let path = out_dir.join(format!("{prefix}-{stamp}-{hex}{ext}"));
        match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(buf).map_err(|e| HyadesError::new("internal", format!("writing {}: {e}", path.display())))?;
                return Ok(path.to_string_lossy().into_owned());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(HyadesError::new("internal", format!("writing {}: {e}", path.display()))),
        }
    }
}
