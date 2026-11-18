use crate::effects;
use crate::ipfs;
use tachyonfx::{Duration, EffectManager};

pub struct TabsState<'a> {
    pub titles: Vec<&'a str>,
    pub index: usize,
}

impl<'a> TabsState<'a> {
    pub const fn new(titles: Vec<&'a str>) -> Self {
        Self { titles, index: 0 }
    }
    pub fn next(&mut self) {
        self.index = (self.index + 1) % self.titles.len();
    }

    pub fn previous(&mut self) {
        if self.index > 0 {
            self.index -= 1;
        } else {
            self.index = self.titles.len() - 1;
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputTarget {
    Connect,
    Fetch,
    Publish,
    Chat,
    KuboRpc,
    ServicesSet,
    GitClone,
    GitAdvertise,
    GitCloneSmart,
    GitPullSmart,
    IssueCreate,
    RepoPublish,
    /// The `:`-bar command line — head word = bridge op, rest = argument.
    RawCommand,
}

/// One visible row of the Code tab file tree: connector prefix (the
/// ├──/└──/│ guide lines), entry name, repo-relative path, and whether
/// it is a directory.
#[derive(Clone)]
pub struct TreeRow {
    pub prefix: String,
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

pub struct App<'a> {
    pub title: &'a str,
    pub should_quit: bool,
    pub tabs: TabsState<'a>,
    pub effects: EffectManager<EffectKey>,
    pub last_frame: web_time::Instant,
    /// Latest snapshot of the JS IPFS backend (js/ipfs-node.js), refreshed
    /// from `window.__ipfsState` — see src/ipfs.rs and
    /// docs/rust-js-bridge.md.
    pub ipfs: ipfs::Snapshot,
    ipfs_poll_counter: u32,
    /// Single-line input buffer (bottom of a tab) and what submitting it
    /// does. While active, char keys edit the buffer instead of hitting
    /// the global key handler.
    pub input_active: bool,
    pub input_buffer: String,
    pub input_target: InputTarget,
    /// Command id awaiting its async result, with the target it belongs to.
    pub pending: Option<(u64, InputTarget)>,
    /// One-line status shown on the active tab (command results/errors).
    pub last_result: String,
    /// Fetched content for the Wiki tab (text or directory listing).
    pub fetch_output: String,
    /// Publish result lines (CID, gateway URL, pin command).
    pub publish_output: String,
    /// Repo publish result (root CID + commands).
    pub repo_output: String,
    /// Expanded directories in the Code tab's file tree (paths relative to
    /// the repo root), and the cursor row over the visible rows.
    pub open_dirs: std::collections::BTreeSet<String>,
    pub tree_cursor: usize,
    /// Cursor row in the Issues tab listing (drives the detail panel).
    pub issue_cursor: usize,
    /// Cursor row in the Actions tab workflow list.
    pub wf_cursor: usize,
    /// Vim-style `:` command bar (any bridge op, any tab). A true PTY
    /// terminal is impossible here — the TUI renders from wasm, which
    /// cannot spawn processes — so this is the in-app command line.
    pub cmd_open: bool,
    pub cmd_buffer: String,
    pub cmd_output: String,
    /// lazygit-style `?` help overlay.
    pub help_open: bool,
}

#[derive(Clone, Copy, Debug, Default, Ord, PartialOrd, Eq, PartialEq)]
pub enum EffectKey {
    #[default]
    ChangeTab,
}

impl<'a> App<'a> {
    pub fn new(title: &'a str) -> Self {
        let mut effects = EffectManager::default();
        effects.add_effect(effects::startup());
        App {
            title,
            should_quit: false,
            tabs: TabsState::new(vec![
                "Code", "Issues", "Pulls", "Actions", "Projects", "Wiki", "Security", "Insights",
                "Settings", "Peer", "Publish",
            ]),
            effects,
            last_frame: web_time::Instant::now(),
            ipfs: ipfs::Snapshot::default(),
            ipfs_poll_counter: 0,
            input_active: false,
            input_buffer: String::new(),
            input_target: InputTarget::Connect,
            pending: None,
            last_result: String::new(),
            fetch_output: String::new(),
            publish_output: String::new(),
            repo_output: String::new(),
            open_dirs: std::collections::BTreeSet::new(),
            tree_cursor: 0,
            issue_cursor: 0,
            wf_cursor: 0,
            cmd_open: false,
            cmd_buffer: String::new(),
            cmd_output: String::new(),
            help_open: false,
        }
    }

    pub fn on_right(&mut self) {
        self.tabs.next();
        self.add_transition_tab_effect();
    }

    pub fn on_left(&mut self) {
        self.tabs.previous();
        self.add_transition_tab_effect();
    }

    /// Immediate children of `dir` in the repo file tree: directories
    /// first (flagged true), then files.
    fn code_entries_in(&self, dir: &str) -> Vec<(String, bool)> {
        let prefix = if dir.is_empty() {
            String::new()
        } else {
            format!("{dir}/")
        };
        let mut dirs: Vec<String> = vec![];
        let mut files: Vec<String> = vec![];
        for path in &self.ipfs.repo_files {
            if !path.starts_with(&prefix) {
                continue;
            }
            let rest = &path[prefix.len()..];
            if rest.is_empty() {
                continue;
            }
            match rest.split_once('/') {
                Some((head, _)) => {
                    if !dirs.iter().any(|d| d == head) {
                        dirs.push(head.to_string());
                    }
                }
                None => files.push(rest.to_string()),
            }
        }
        dirs.sort_by_key(|a| a.to_lowercase());
        files.sort_by_key(|a| a.to_lowercase());
        dirs.into_iter()
            .map(|d| (d, true))
            .chain(files.into_iter().map(|f| (f, false)))
            .collect()
    }

    /// The fully rendered tree: recursive walk with expand-in-place — a
    /// directory's children appear (indented, connector-lined) only while
    /// its path sits in `open_dirs`.
    pub fn code_tree_rows(&self) -> Vec<TreeRow> {
        fn walk(app: &App, dir: &str, prefix: String, rows: &mut Vec<TreeRow>) {
            let entries = app.code_entries_in(dir);
            let total = entries.len();
            for (i, (name, is_dir)) in entries.iter().enumerate() {
                let last = i + 1 == total;
                let connector = if last { "└── " } else { "├── " };
                let path = if dir.is_empty() {
                    name.clone()
                } else {
                    format!("{dir}/{name}")
                };
                let is_open = *is_dir && app.open_dirs.contains(&path);
                rows.push(TreeRow {
                    prefix: format!("{prefix}{connector}"),
                    name: name.clone(),
                    path: path.clone(),
                    is_dir: *is_dir,
                });
                if is_open {
                    let child_prefix = format!("{prefix}{}", if last { "    " } else { "│   " });
                    walk(app, &path, child_prefix, rows);
                }
            }
        }
        let mut rows = vec![];
        walk(self, "", String::new(), &mut rows);
        rows
    }

    /// Up arrow: move the cursor in the active tab's list (Code tree,
    /// Issues), if it has one.
    pub fn on_up(&mut self) {
        match self.tabs.index {
            0 if self.tree_cursor > 0 => self.tree_cursor -= 1,
            1 if self.issue_cursor > 0 => self.issue_cursor -= 1,
            3 if self.wf_cursor > 0 => self.wf_cursor -= 1,
            _ => {}
        }
    }

    /// Down arrow — cursor clamps at render against the live entry count.
    pub fn on_down(&mut self) {
        match self.tabs.index {
            0 => self.tree_cursor += 1,
            1 => self.issue_cursor += 1,
            3 => self.wf_cursor += 1,
            _ => {}
        }
    }

    /// Enter expands/collapses the directory under the cursor (leaf rows
    /// are no-ops).
    pub fn on_code_enter(&mut self) {
        if self.tabs.index != 0 {
            return;
        }
        let rows = self.code_tree_rows();
        let Some(row) = rows.get(self.tree_cursor) else {
            return;
        };
        if row.is_dir && !self.open_dirs.remove(&row.path) {
            self.open_dirs.insert(row.path.clone());
        }
    }

    /// Backspace collapses the whole tree back to the root listing.
    pub fn on_code_back(&mut self) {
        if self.tabs.index == 0 {
            self.open_dirs.clear();
            self.tree_cursor = 0;
        }
    }

    pub fn on_key(&mut self, c: char) {
        match c {
            'q' => {
                self.should_quit = true;
            }
            '?' => {
                self.help_open = !self.help_open;
            }
            // lazygit-style digit jumps: 1-9 select tabs 1-9, 0 selects tab 10.
            '1'..='9' => {
                let idx = (c as usize) - ('1' as usize);
                if idx < self.tabs.titles.len() {
                    self.tabs.index = idx;
                    self.add_transition_tab_effect();
                }
            }
            '0' => {
                if self.tabs.titles.len() > 9 {
                    self.tabs.index = 9;
                    self.add_transition_tab_effect();
                }
            }
            ':' | '\\' => {
                // Vim-style command bar, available on every tab.
                self.cmd_open = true;
                self.cmd_buffer.clear();
            }
            // Code: publish the whole repo tree to IPFS.
            'p' if self.tabs.index == 0 => {
                if let Some(id) = ipfs::cmd("repo.publishAll", "{}") {
                    self.pending = Some((id, InputTarget::RepoPublish));
                    self.last_result = "publishing repo tree...".to_string();
                }
            }
            // Issues.
            'i' if self.tabs.index == 1 => self.start_input(InputTarget::IssueCreate),
            'j' if self.tabs.index == 1 => self.on_down(),
            'k' if self.tabs.index == 1 => self.on_up(),
            's' if self.tabs.index == 1 => {
                if let Some(id) = ipfs::cmd("issues.sync", "{}") {
                    self.pending = Some((id, InputTarget::IssueCreate));
                    self.last_result = "syncing issues from IPNS...".to_string();
                }
            }
            // Actions.
            'j' if self.tabs.index == 3 => self.on_down(),
            'k' if self.tabs.index == 3 => self.on_up(),
            // Pulls: clone / advertise through the app.
            'c' if self.tabs.index == 2 => self.start_input(InputTarget::GitClone),
            'a' if self.tabs.index == 2 => self.start_input(InputTarget::GitAdvertise),
            's' if self.tabs.index == 2 => self.start_input(InputTarget::GitCloneSmart),
            'u' if self.tabs.index == 2 => self.start_input(InputTarget::GitPullSmart),
            'l' if self.tabs.index == 2 => {
                if let Some(id) = ipfs::cmd("git.clones", "{}") {
                    self.pending = Some((id, InputTarget::GitCloneSmart));
                    self.last_result = "listing clones...".to_string();
                }
            }
            // Wiki: fetch a CID's content for reading.
            'f' if self.tabs.index == 5 => self.start_input(InputTarget::Fetch),
            // Settings: optional service endpoints.
            's' if self.tabs.index == 8 => self.start_input(InputTarget::ServicesSet),
            // Peer: dial a multiaddr, or chat over gossipsub.
            'c' if self.tabs.index == 9 => self.start_input(InputTarget::Connect),
            'm' if self.tabs.index == 9 => self.start_input(InputTarget::Chat),
            // Publish: arbitrary text/content.
            'p' if self.tabs.index == 10 => self.start_input(InputTarget::Publish),
            _ => {}
        }
    }

    pub fn start_input(&mut self, target: InputTarget) {
        self.input_active = true;
        self.input_target = target;
        self.input_buffer.clear();
    }

    pub fn cancel_input(&mut self) {
        self.input_active = false;
        self.input_buffer.clear();
    }

    pub fn on_input_char(&mut self, c: char) {
        self.input_buffer.push(c);
    }

    pub fn on_input_backspace(&mut self) {
        self.input_buffer.pop();
    }

    /// Escape a string for embedding in a JSON string literal.
    fn json_escape(s: &str) -> String {
        let mut out = String::with_capacity(s.len() + 8);
        for ch in s.chars() {
            match ch {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out
    }

    /// Submit the `:`-bar command: first word is the bridge op, the rest is
    /// its argument. `kubo <method> [args]` (or bare `rpc`) routes to the
    /// generic RPC op. Result lands in cmd_output.
    pub fn submit_cmd(&mut self) {
        let line = self.cmd_buffer.trim().to_string();
        self.cmd_open = false;
        self.cmd_buffer.clear();
        if line.is_empty() {
            return;
        }
        let mut parts = line.split_whitespace();
        let head = parts.next().unwrap_or("");
        let rest: Vec<&str> = parts.collect();
        let rest_joined = rest.join(" ");
        let (op, arg) = if head == "kubo" || head == "rpc" {
            let method = rest.first().copied().unwrap_or("");
            let args: Vec<String> = rest
                .iter()
                .skip(1)
                .map(|p| format!("\"{}\"", Self::json_escape(p)))
                .collect();
            (
                "kubo.rpc",
                format!(
                    "{{\"method\":\"{}\",\"args\":[{}]}}",
                    Self::json_escape(method),
                    args.join(",")
                ),
            )
        } else if head == "services" {
            ("services.set", format!("{{\"services\":{rest_joined}}}"))
        } else {
            // Every op reads the fields it needs: t0 as addr/cid, t1 as
            // sha, the whole remainder as text/rootCid.
            let arg = if rest.len() == 1 {
                format!(
                    "{{\"addr\":\"{0}\",\"cid\":\"{0}\",\"text\":\"{0}\",\"rootCid\":\"{0}\"}}",
                    Self::json_escape(&rest_joined)
                )
            } else {
                format!(
                    "{{\"addr\":\"{0}\",\"cid\":\"{0}\",\"sha\":\"{1}\",\"text\":\"{2}\",\"rootCid\":\"{2}\"}}",
                    rest.first().map(|t| Self::json_escape(t)).unwrap_or_default(),
                    rest.get(1).map(|t| Self::json_escape(t)).unwrap_or_default(),
                    Self::json_escape(&rest_joined)
                )
            };
            (head, arg)
        };
        if let Some(id) = ipfs::cmd(op, &arg) {
            self.pending = Some((id, InputTarget::RawCommand));
            self.cmd_output = format!("{line} -> working...");
        } else {
            self.cmd_output = "bridge unavailable (window.__ipfsCmd missing)".to_string();
        }
    }

    /// Submit the input buffer as a bridge command and arm result pickup.
    pub fn submit_input(&mut self) {
        // Generic Kubo RPC: "<method> [arg...]" — the whole API surface
        // through one bridge op.
        if self.input_target == InputTarget::KuboRpc {
            let mut parts = self.input_buffer.split_whitespace();
            let method = parts.next().unwrap_or("");
            let args: Vec<String> = parts
                .map(|p| format!("\"{}\"", Self::json_escape(p)))
                .collect();
            let arg = format!(
                "{{\"method\":\"{}\",\"args\":[{}]}}",
                Self::json_escape(method),
                args.join(",")
            );
            if let Some(id) = ipfs::cmd("kubo.rpc", &arg) {
                self.pending = Some((id, InputTarget::KuboRpc));
                self.last_result = "working...".to_string();
            } else {
                self.last_result = "bridge unavailable (window.__ipfsCmd missing)".to_string();
            }
            self.cancel_input();
            return;
        }
        // arg carries every field the ops understand; each op reads what it
        // needs. `services` is the raw buffer (must be a JSON array) and is
        // only meaningful for the services.set target.
        let arg = format!(
            "{{\"addr\":\"{0}\",\"cid\":\"{0}\",\"text\":\"{0}\",\"rootCid\":\"{0}\",\"services\":{1}}}",
            Self::json_escape(&self.input_buffer),
            self.input_buffer.trim()
        );
        let op = match self.input_target {
            InputTarget::Connect => "connect",
            InputTarget::Fetch => "fetch",
            InputTarget::Publish => "publish",
            InputTarget::Chat => "chatSend",
            InputTarget::KuboRpc => "kubo.rpc",
            InputTarget::ServicesSet => "services.set",
            InputTarget::GitClone => "git.clone",
            InputTarget::GitAdvertise => "git.advertise",
            InputTarget::GitCloneSmart => "git.cloneSmart",
            InputTarget::GitPullSmart => "git.pullSmart",
            InputTarget::IssueCreate => "issues.create",
            InputTarget::RepoPublish => "repo.publishAll",
            InputTarget::RawCommand => "raw-command",
        };
        if let Some(id) = ipfs::cmd(op, &arg) {
            self.pending = Some((id, self.input_target));
            self.last_result = "working...".to_string();
        } else {
            self.last_result = "bridge unavailable (window.__ipfsCmd missing)".to_string();
        }
        self.cancel_input();
    }

    fn finish_pending(&mut self) {
        let Some((id, target)) = self.pending else {
            return;
        };
        let Some(result) = ipfs::take_result(id) else {
            return;
        };
        self.pending = None;
        match result {
            Ok(value) => {
                self.last_result = match target {
                    InputTarget::Fetch => {
                        // Surface the pre-rendered content, not the JSON wrapper.
                        let body = ipfs::json_field(&value, "display")
                            .or_else(|| ipfs::json_field(&value, "text"))
                            .unwrap_or_else(|| value.clone());
                        self.fetch_output = body.clone();
                        format!("fetched ({} bytes)", body.len())
                    }
                    InputTarget::Publish => {
                        // One fact per line, full values (working agreement).
                        let cid = ipfs::json_field(&value, "cid").unwrap_or_default();
                        let url = ipfs::json_field(&value, "gatewayUrl").unwrap_or_default();
                        let pin = ipfs::json_field(&value, "pinCmd").unwrap_or_default();
                        let summary = format!("published {cid}");
                        self.publish_output = format!("CID: {cid}\nGateway: {url}\n{pin}");
                        summary
                    }
                    InputTarget::Chat => "sent".to_string(),
                    InputTarget::Connect => "connected".to_string(),
                    InputTarget::KuboRpc => {
                        let method = ipfs::json_field(&value, "method").unwrap_or_default();
                        let response = ipfs::json_field(&value, "response").unwrap_or(value);
                        format!("{method}: {response}")
                    }
                    InputTarget::ServicesSet => format!("services: {value}"),
                    InputTarget::GitClone => {
                        let zip = ipfs::json_field(&value, "zipName").unwrap_or_default();
                        let bytes = ipfs::json_field(&value, "bytes").unwrap_or_default();
                        let bare = ipfs::json_field(&value, "bareRepo").unwrap_or_default();
                        format!("cloned to {zip} ({bytes} bytes, bare repo: {bare})")
                    }
                    InputTarget::GitAdvertise => format!("advertised: {value}"),
                    InputTarget::GitCloneSmart => {
                        // Two ops share this target: cloneSmart returns
                        // name/branches/tags; git.clones returns a clones list.
                        if let Some(list) = ipfs::json_field(&value, "clones") {
                            let names: Vec<String> = list
                                .trim_matches(|c| c == '[' || c == ']')
                                .split("{\"name\":")
                                .skip(1)
                                .filter_map(|s| s.split('"').nth(1).map(str::to_string))
                                .collect();
                            if names.is_empty() {
                                "no clones yet".to_string()
                            } else {
                                format!("clones: {}", names.join(", "))
                            }
                        } else {
                            let name = ipfs::json_field(&value, "name").unwrap_or_default();
                            let branches = ipfs::json_field(&value, "branches").unwrap_or_default();
                            let tags = ipfs::json_field(&value, "tags").unwrap_or_default();
                            format!("cloned {name} (branches: {branches}, tags: {tags})")
                        }
                    }
                    InputTarget::GitPullSmart => {
                        let advanced = ipfs::json_field(&value, "advanced").unwrap_or_default();
                        let after = ipfs::json_field(&value, "after").unwrap_or_default();
                        if advanced == "true" {
                            format!("updated to {after}")
                        } else {
                            "already up to date".to_string()
                        }
                    }
                    InputTarget::IssueCreate => {
                        // create returns cid/tip; sync returns issues/name.
                        if let Some(cid) = ipfs::json_field(&value, "cid") {
                            self.cmd_output = format!("ipfs pin add {cid}");
                            format!("issue filed: {cid}")
                        } else {
                            let n = ipfs::json_field(&value, "issues").unwrap_or_default();
                            format!("synced ({n} issue(s) in view)")
                        }
                    }
                    InputTarget::RawCommand => {
                        self.cmd_output = value;
                        String::new()
                    }
                    InputTarget::RepoPublish => {
                        // One fact per line, full values.
                        let root = ipfs::json_field(&value, "rootCid").unwrap_or_default();
                        let count = ipfs::json_field(&value, "fileCount").unwrap_or_default();
                        let url = ipfs::json_field(&value, "gatewayUrl").unwrap_or_default();
                        let pin = ipfs::json_field(&value, "pinCmd").unwrap_or_default();
                        let import = ipfs::json_field(&value, "importCmd").unwrap_or_default();
                        let summary = format!("repo published: {root} ({count} files)");
                        self.repo_output = format!(
                            "Root CID: {root}\nGateway: {url}\n{pin}\n{import}\n\nserve envelope advertised on repo-gossip"
                        );
                        summary
                    }
                };
            }
            Err(error) => {
                self.last_result = format!("error: {error}");
            }
        }
    }

    pub fn on_tick(&mut self) -> Duration {
        // Refresh the IPFS backend snapshot ~every half second (the draw
        // loop runs at display refresh rate; Reflect reads are cheap but
        // not free).
        self.ipfs_poll_counter = self.ipfs_poll_counter.wrapping_add(1);
        if self.ipfs_poll_counter % 30 == 0 {
            self.ipfs = ipfs::poll();
        }
        self.finish_pending();

        // calculate elapsed time since last frame
        let now = web_time::Instant::now();
        let elapsed = now.duration_since(self.last_frame).as_millis() as u32;
        self.last_frame = now;

        Duration::from_millis(elapsed)
    }

    fn add_transition_tab_effect(&mut self) {
        let effect = effects::change_tab();
        self.effects.add_unique_effect(EffectKey::ChangeTab, effect);
    }
}
