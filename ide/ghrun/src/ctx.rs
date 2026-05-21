// ctx.rs — QDIR path context
// ghrun.exe lives at: <QDIR>/f/ghrun.exe
// Auto-infers QDIR from its own location, no env var required.
// But respects QDIR env var if explicitly set (e.g. during dev/CI).
//
// QDIR layout:
//   QDIR/
//   ├── qqq.exe
//   └── f/                    ← VS Code portable data (dataFolderName = "f")
//       ├── ghrun.exe          ← THIS BINARY
//       ├── user-data/         ← VS Code user settings/keybindings
//       ├── extensions/        ← pre-installed + user extensions
//       ├── components/        ← python/ffmpeg/yt-dlp/git
//       ├── goods/             ← gaea goods
//       ├── tmp/               ← scratch space
//       ├── cache/             ← download cache
//       └── logs/              ← runtime logs

use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Ctx {
    /// IDE portable root, e.g. /path/to/qqq-ide/
    pub qdir: PathBuf,
    /// f/ — VS Code portable data folder (triggers portable mode)
    pub f: PathBuf,
    /// f/user-data/ — VS Code user settings, keybindings, state
    pub user_data: PathBuf,
    /// f/extensions/ — pre-installed first-party + user extensions
    pub extensions: PathBuf,
    /// f/components/ — python / ffmpeg / yt-dlp / git
    pub components: PathBuf,
    /// f/goods/ — installed gaea goods
    pub goods: PathBuf,
    /// f/tmp/ — scratch space for downloads / extractions
    pub tmp: PathBuf,
    /// f/cache/ — download cache, ETag cache
    pub cache: PathBuf,
    /// f/logs/ — ghrun + component logs
    pub logs: PathBuf,
}

impl Ctx {
    pub fn detect() -> Self {
        let qdir = Self::infer_qdir();
        let f = qdir.join("f");
        Ctx {
            user_data:  f.join("user-data"),
            extensions: f.join("extensions"),
            components: f.join("components"),
            goods:      f.join("goods"),
            tmp:        f.join("tmp"),
            cache:      f.join("cache"),
            logs:       f.join("logs"),
            f,
            qdir,
        }
    }

    fn infer_qdir() -> PathBuf {
        // Priority 1: explicit env var (dev / CI)
        if let Ok(v) = std::env::var("QDIR") {
            let p = PathBuf::from(&v);
            if p.exists() { return p; }
        }
        // Priority 2: infer from ghrun.exe location
        // ghrun.exe is expected at <QDIR>/f/ghrun[.exe]
        if let Ok(exe) = std::env::current_exe() {
            if let Some(f_dir) = exe.parent() {          // → f/
                if let Some(root) = f_dir.parent() {     // → QDIR
                    return root.to_path_buf();
                }
            }
        }
        // Priority 3: cwd fallback (local dev)
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    }

    /// Ensure all QDIR directories exist.
    pub fn init_dirs(&self) -> std::io::Result<()> {
        for d in [
            &self.f, &self.user_data, &self.extensions,
            &self.components, &self.goods, &self.tmp,
            &self.cache, &self.logs,
        ] {
            std::fs::create_dir_all(d)?;
        }
        Ok(())
    }

    pub fn component_dir(&self, name: &str) -> PathBuf {
        self.components.join(name)
    }

    pub fn goods_dir(&self, id: &str) -> PathBuf {
        self.goods.join(id)
    }
}
