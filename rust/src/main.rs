use std::env;
use std::fs;
use std::process::Command;

fn run_ipfs_add(dir: &str, ipfs_path: Option<&str>) -> Result<String, String> {
    let mut cmd = Command::new("ipfs");
    cmd.args(["add", "-r", "-q", dir]);
    if let Some(p) = ipfs_path {
        cmd.env("IPFS_PATH", p);
    }
    let output = cmd.output().map_err(|e| format!("failed to run `ipfs`: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let cids: Vec<&str> = stdout.lines().filter(|l| !l.trim().is_empty()).collect();
    cids.last()
        .map(|s| s.trim().to_string())
        .ok_or_else(|| "no CID returned by ipfs".to_string())
}

fn main() {
    let dir = env::args().nth(1).unwrap_or_else(|| ".".to_string());

    // First try the user's default IPFS repository.
    match run_ipfs_add(&dir, None) {
        Ok(cid) => {
            println!("{cid}");
            return;
        }
        Err(err) if err.contains("old style") || err.contains("datatstore") => {
            // Fall back to a fresh, temporary repository.
        }
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    }

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

    match run_ipfs_add(&dir, Some(temp.to_str().unwrap())) {
        Ok(cid) => println!("{cid}"),
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    }
}
