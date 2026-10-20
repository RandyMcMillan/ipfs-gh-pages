use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn ipfs_available() -> bool {
    Command::new("ipfs")
        .arg("version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn install_ipfs() -> bool {
    if cfg!(target_os = "macos") {
        Command::new("brew")
            .args(["install", "kubo"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    } else if cfg!(target_os = "windows") {
        if Command::new("choco")
            .args(["install", "kubo", "-y"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return true;
        }
        Command::new("scoop")
            .args(["install", "kubo"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    } else {
        if Command::new("apt-get")
            .args(["install", "-y", "kubo"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return true;
        }
        if Command::new("dnf")
            .args(["install", "-y", "kubo"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return true;
        }
        false
    }
}

fn repo_root(dir: &str) -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(dir)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn tracked_files(root: &str) -> Option<Vec<String>> {
    let out = Command::new("git")
        .args(["ls-files", "-z"])
        .current_dir(root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Some(text.split('\0').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect())
}

fn fallback_files(root: &str) -> Vec<String> {
    let mut result = Vec::new();
    fn walk(base: &str, cur: &Path, out: &mut Vec<String>) {
        if let Ok(entries) = fs::read_dir(cur) {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if name == ".git" || name == "node_modules" || name == "target" || name == "dist" {
                    continue;
                }
                if path.is_dir() {
                    walk(base, &path, out);
                } else if path.is_file() {
                    if let Ok(rel) = path.strip_prefix(base) {
                        out.push(rel.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    walk(root, Path::new(root), &mut result);
    result
}

fn stage_files(root: &str, files: &[String]) -> PathBuf {
    let stage = env::temp_dir().join("ipfs-gh-pages-files");
    let _ = fs::remove_dir_all(&stage);
    fs::create_dir_all(&stage).expect("failed to create staging dir");
    for rel in files {
        let src = Path::new(root).join(rel);
        let dst = stage.join(rel);
        if let Some(parent) = dst.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::copy(&src, &dst);
    }
    stage
}

fn run_ipfs_add(stage: &Path, ipfs_path: Option<&str>, verbose: bool) -> Result<(String, Vec<String>), String> {
    let mut cmd = Command::new("ipfs");
    if verbose {
        cmd.args(["add", "-r", stage.to_str().unwrap()]);
    } else {
        cmd.args(["add", "-r", "-Q", stage.to_str().unwrap()]);
    }
    if let Some(p) = ipfs_path {
        cmd.env("IPFS_PATH", p);
    }
    let output = cmd.output().map_err(|e| format!("failed to run `ipfs`: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<String> = stdout.lines().map(|s| s.to_string()).filter(|s| !s.trim().is_empty()).collect();
    let root = lines
        .last()
        .map(|s| s.trim().to_string())
        .ok_or_else(|| "no CID returned by ipfs".to_string())?;
    Ok((root, lines))
}

fn main() {
    if !ipfs_available() {
        eprintln!("`ipfs` not found on PATH. Attempting installation...");
        if !install_ipfs() {
            eprintln!(
                "Automatic installation failed. Please install Kubo (IPFS) manually:\n\
  macOS:   brew install kubo\n\
  Windows: choco install kubo   (or: scoop install kubo)\n\
  Linux:   see https://docs.ipfs.tech/install/command-line/"
            );
            std::process::exit(1);
        }
        if !ipfs_available() {
            eprintln!("`ipfs` still not available after installation.");
            std::process::exit(1);
        }
    }

    let mut verbose = false;
    let mut dir = ".".to_string();
    let mut has_dir_arg = false;
    for arg in env::args().skip(1) {
        if arg == "-v" || arg == "--verbose" {
            verbose = true;
        } else {
            dir = arg;
            has_dir_arg = true;
        }
    }
    if !has_dir_arg {
        if let Ok(cwd) = env::current_dir() {
            if cwd.file_name().and_then(|n| n.to_str()) == Some("rust") {
                dir = "..".to_string();
            }
        }
    }

    let root = repo_root(&dir).unwrap_or_else(|| dir.clone());
    let files = tracked_files(&root).unwrap_or_else(|| fallback_files(&root));
    let stage = stage_files(&root, &files);

    let result = run_ipfs_add(&stage, None, verbose);
    let (cid, lines) = match result {
        Ok(r) => r,
        Err(err) if err.contains("old style") || err.contains("datatstore") => {
            let temp = env::temp_dir().join("ipfs-gh-pages-repo");
            let _ = fs::remove_dir_all(&temp);
            fs::create_dir_all(&temp).expect("failed to create temp repo dir");

            let init = Command::new("ipfs")
                .env("IPFS_PATH", &temp)
                .arg("init")
                .output()
                .expect("failed to run `ipfs init`");
            if !init.status.success() {
                eprintln!("{}", String::from_utf8_lossy(&init.stderr));
                std::process::exit(1);
            }

            match run_ipfs_add(&stage, Some(temp.to_str().unwrap()), verbose) {
                Ok(r) => r,
                Err(err) => {
                    eprintln!("{err}");
                    std::process::exit(1);
                }
            }
        }
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    };

    let _ = fs::remove_dir_all(&stage);

    if verbose {
        for line in &lines {
            eprintln!("{line}");
        }
    }
    println!("{cid}");
}
