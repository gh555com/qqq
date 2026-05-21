// install.rs — gaea goods installation.
// A "good" is anything in the gaea marketplace: tools, games, language packs, etc.
// Each good has a gaea.json (our protocol) and lives in f/goods/<id>/.

use crate::ctx::Ctx;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

fn emit(obj: serde_json::Value) {
    println!("{}", obj);
    let _ = std::io::Write::flush(&mut std::io::stdout());
}

// ---------------------------------------------------------------------------
// gaea.json subset we care about at install time
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct GaeaManifest {
    pub id:          String,
    pub name:        String,
    pub version:     String,
    pub install:     InstallInfo,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InstallInfo {
    pub download_url: String,
    pub sha256:       Option<String>,
    pub size_mb:      Option<f64>,
    pub target_dir:   Option<String>,   // QDIR_BUILTIN | QDIR_GOODS
}

// ---------------------------------------------------------------------------
// Install a good from its gaea.json URL or local path
// ---------------------------------------------------------------------------

/// `ghrun install <download_url>` — fetch gaea.json, then download + extract good.
/// Idempotent: checks version file before re-downloading.
pub fn install_good_from_url(ctx: &Ctx, manifest_url: &str) -> Result<(), String> {
    emit(serde_json::json!({"event": "install_start", "url": manifest_url}));

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let body = client.get(manifest_url).send().map_err(|e| e.to_string())?
        .text().map_err(|e| e.to_string())?;

    let manifest: GaeaManifest = serde_json::from_str(&body)
        .map_err(|e| format!("invalid gaea.json: {}", e))?;

    install_good(ctx, &manifest)
}

/// Install a good from a parsed GaeaManifest.
pub fn install_good(ctx: &Ctx, manifest: &GaeaManifest) -> Result<(), String> {
    let target = match manifest.install.target_dir.as_deref() {
        Some("QDIR_BUILTIN") => ctx.extensions.join(&manifest.id),
        _                    => ctx.goods.join(&manifest.id),
    };

    // Already installed at same version?
    let ver_file = target.join(".version");
    if ver_file.exists() {
        let installed = fs::read_to_string(&ver_file).unwrap_or_default();
        if installed.trim() == manifest.version {
            emit(serde_json::json!({"event":"already_installed","id":manifest.id,"version":manifest.version}));
            return Ok(());
        }
    }

    emit(serde_json::json!({"event":"install_download","id":manifest.id,"version":manifest.version}));

    let tmp_archive = ctx.tmp.join(format!("{}-{}.zip", manifest.id, manifest.version));
    download_file(&manifest.install.download_url, &tmp_archive)?;

    if let Some(sha) = &manifest.install.sha256 {
        if !sha.is_empty() {
            verify_sha256(&tmp_archive, sha)?;
        }
    }

    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    extract_zip(&tmp_archive, &target)?;

    fs::write(&ver_file, &manifest.version).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&tmp_archive);

    emit(serde_json::json!({"event":"install_done","id":manifest.id,"version":manifest.version,
                             "path": target.to_string_lossy().to_string()}));
    Ok(())
}

// ---------------------------------------------------------------------------
// List installed goods
// ---------------------------------------------------------------------------

pub fn list_goods(ctx: &Ctx) {
    let dirs = [
        ("builtin", &ctx.extensions),
        ("goods",   &ctx.goods),
    ];
    for (label, dir) in &dirs {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let version = fs::read_to_string(path.join(".version")).unwrap_or_else(|_| "?".into());
                let id = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                emit(serde_json::json!({"event":"list","tier":label,"id":id,"version":version.trim()}));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers (reused from ensure.rs logic — kept local to avoid coupling)
// ---------------------------------------------------------------------------

fn download_file(url: &str, dest: &PathBuf) -> Result<(), String> {
    use std::io::{Read, Write};
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build().map_err(|e| e.to_string())?;
    let mut resp = client.get(url).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let mut f = fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 65536];
    let total = resp.content_length().unwrap_or(0);
    let mut got: u64 = 0;
    loop {
        let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        f.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        got += n as u64;
        if total > 0 && got % (1 << 20) == 0 {
            emit(serde_json::json!({"event":"progress","downloaded":got,"total":total}));
        }
    }
    Ok(())
}

fn verify_sha256(path: &PathBuf, expected: &str) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 65536];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        h.update(&buf[..n]);
    }
    let got = hex::encode(h.finalize());
    if got.to_lowercase() != expected.to_lowercase() {
        return Err(format!("sha256 mismatch: {} vs {}", got, expected));
    }
    Ok(())
}

fn extract_zip(archive: &PathBuf, dest: &PathBuf) -> Result<(), String> {
    use std::io;
    let f = fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut z = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
    // detect and strip top-level directory prefix
    let prefix = if z.len() > 0 {
        z.by_index(0).ok()
         .and_then(|e| { let n = e.name().to_string(); n.find('/').map(|i| n[..=i].to_string()) })
         .unwrap_or_default()
    } else { String::new() };
    for i in 0..z.len() {
        let mut zf = z.by_index(i).map_err(|e| e.to_string())?;
        let raw = zf.name().to_string();
        let rel = if !prefix.is_empty() && raw.starts_with(&prefix) { &raw[prefix.len()..] } else { &raw };
        if rel.is_empty() || rel.ends_with('/') { continue; }
        let out = dest.join(rel);
        if let Some(p) = out.parent() { fs::create_dir_all(p).map_err(|e| e.to_string())?; }
        let mut outf = fs::File::create(&out).map_err(|e| e.to_string())?;
        io::copy(&mut zf, &mut outf).map_err(|e| e.to_string())?;
    }
    Ok(())
}
