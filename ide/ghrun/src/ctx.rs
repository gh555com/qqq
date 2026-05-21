// ctx.rs — QDIR path context
// ghrun.exe lives at: <QDIR>/f/ghrun.exe
// Auto-infers QDIR from its own location, no env var required.
// But respects QDIR env var if explicitly set (e.g. during dev/CI).

use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Ctx {
    /// IDE portable root, e.g. /path/to/qqq-ide/
    pub qdir: PathBuf,
    /// f/ — portable data root (triggers VS Code portable mode)
    pub f: PathBuf,
    /// f/a/ — user data (settings, keybindings …)
    pub data: PathBuf,
    /// f/e/ — first-party extensions (qqq-core, qqq-ai …)
    pub builtin: PathBuf,
    /// f/components/ — python / ffmpeg / yt-dlp / git
    pub components: PathBuf,
    /// f/goods/ — installed gaea goods
    pub goods: PathBuf,
    /// f/tmp/ — scratch space for downloads / extractions
    pub tmp: PathBuf,
}

impl Ctx {
    pub fn detect() -> Self {
        let qdir = Self::infer_qdir();
        let f = qdir.join("f");
        Ctx {
            data:       f.join("a"),
            builtin:    f.join("e"),
            components: f.join("components"),
            goods:      f.join("goods"),
            tmp:        f.join("tmp"),
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
        for d in [&self.f, &self.data, &self.builtin, &self.components, &self.goods, &self.tmp] {
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
