use crate::effects;
use crate::ipfs;
use rand::{
    distr::{Distribution, Uniform},
    rngs::SmallRng,
    SeedableRng,
};
use ratzilla::ratatui::widgets::ListState;
use tachyonfx::{Duration, EffectManager};

const TASKS: [&str; 24] = [
    "Item1", "Item2", "Item3", "Item4", "Item5", "Item6", "Item7", "Item8", "Item9", "Item10",
    "Item11", "Item12", "Item13", "Item14", "Item15", "Item16", "Item17", "Item18", "Item19",
    "Item20", "Item21", "Item22", "Item23", "Item24",
];

const LOGS: [(&str, &str); 26] = [
    ("Event1", "INFO"),
    ("Event2", "INFO"),
    ("Event3", "CRITICAL"),
    ("Event4", "ERROR"),
    ("Event5", "INFO"),
    ("Event6", "INFO"),
    ("Event7", "WARNING"),
    ("Event8", "INFO"),
    ("Event9", "INFO"),
    ("Event10", "INFO"),
    ("Event11", "CRITICAL"),
    ("Event12", "INFO"),
    ("Event13", "INFO"),
    ("Event14", "INFO"),
    ("Event15", "INFO"),
    ("Event16", "INFO"),
    ("Event17", "ERROR"),
    ("Event18", "ERROR"),
    ("Event19", "INFO"),
    ("Event20", "INFO"),
    ("Event21", "WARNING"),
    ("Event22", "INFO"),
    ("Event23", "INFO"),
    ("Event24", "WARNING"),
    ("Event25", "INFO"),
    ("Event26", "INFO"),
];

const EVENTS: [(&str, u64); 24] = [
    ("B1", 9),
    ("B2", 12),
    ("B3", 5),
    ("B4", 8),
    ("B5", 2),
    ("B6", 4),
    ("B7", 5),
    ("B8", 9),
    ("B9", 14),
    ("B10", 15),
    ("B11", 1),
    ("B12", 0),
    ("B13", 4),
    ("B14", 6),
    ("B15", 4),
    ("B16", 6),
    ("B17", 4),
    ("B18", 7),
    ("B19", 13),
    ("B20", 8),
    ("B21", 11),
    ("B22", 9),
    ("B23", 3),
    ("B24", 5),
];

#[derive(Clone)]
pub struct RandomSignal {
    distribution: Uniform<u64>,
    rng: SmallRng,
}

impl RandomSignal {
    pub fn new(lower: u64, upper: u64) -> Self {
        Self {
            distribution: Uniform::new(lower, upper).unwrap(),
            rng: SmallRng::seed_from_u64(0),
        }
    }
}

impl Iterator for RandomSignal {
    type Item = u64;
    fn next(&mut self) -> Option<u64> {
        Some(self.distribution.sample(&mut self.rng))
    }
}

#[derive(Clone)]
pub struct SinSignal {
    x: f64,
    interval: f64,
    period: f64,
    scale: f64,
}

impl SinSignal {
    pub const fn new(interval: f64, period: f64, scale: f64) -> Self {
        Self {
            x: 0.0,
            interval,
            period,
            scale,
        }
    }
}

impl Iterator for SinSignal {
    type Item = (f64, f64);
    fn next(&mut self) -> Option<Self::Item> {
        let point = (self.x, (self.x * 1.0 / self.period).sin() * self.scale);
        self.x += self.interval;
        Some(point)
    }
}

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

pub struct StatefulList<T> {
    pub state: ListState,
    pub items: Vec<T>,
}

impl<T> StatefulList<T> {
    pub fn with_items(items: Vec<T>) -> Self {
        Self {
            state: ListState::default(),
            items,
        }
    }

    pub fn next(&mut self) {
        let i = match self.state.selected() {
            Some(i) => {
                if i >= self.items.len() - 1 {
                    0
                } else {
                    i + 1
                }
            }
            None => 0,
        };
        self.state.select(Some(i));
    }

    pub fn previous(&mut self) {
        let i = match self.state.selected() {
            Some(i) => {
                if i == 0 {
                    self.items.len() - 1
                } else {
                    i - 1
                }
            }
            None => 0,
        };
        self.state.select(Some(i));
    }
}

pub struct Signal<S: Iterator> {
    source: S,
    pub points: Vec<S::Item>,
    tick_rate: usize,
}

impl<S> Signal<S>
where
    S: Iterator,
{
    fn on_tick(&mut self) {
        self.points.drain(0..self.tick_rate);
        self.points
            .extend(self.source.by_ref().take(self.tick_rate));
    }
}

pub struct Signals {
    pub sin1: Signal<SinSignal>,
    pub sin2: Signal<SinSignal>,
    pub window: [f64; 2],
}

impl Signals {
    fn on_tick(&mut self) {
        self.sin1.on_tick();
        self.sin2.on_tick();
        self.window[0] += 1.0;
        self.window[1] += 1.0;
    }
}

pub struct Server<'a> {
    pub name: &'a str,
    pub location: &'a str,
    pub coords: (f64, f64),
    pub status: &'a str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputTarget {
    Connect,
    Fetch,
    Publish,
    Chat,
    KuboDetect,
    KuboPin,
    KuboRpc,
    ServicesSet,
    GitClone,
    GitAdvertise,
    RepoPublish,
    /// The `:`-bar command line — head word = bridge op, rest = argument.
    RawCommand,
}

pub struct App<'a> {
    pub title: &'a str,
    pub should_quit: bool,
    pub tabs: TabsState<'a>,
    pub show_chart: bool,
    pub progress: f64,
    pub sparkline: Signal<RandomSignal>,
    pub tasks: StatefulList<&'a str>,
    pub logs: StatefulList<(&'a str, &'a str)>,
    pub signals: Signals,
    pub barchart: Vec<(&'a str, u64)>,
    pub servers: Vec<Server<'a>>,
    pub enhanced_graphics: bool,
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
    /// Fetched content for the Fetch tab (text or directory listing).
    pub fetch_output: String,
    /// Publish result lines (CID, gateway URL, pin command).
    pub publish_output: String,
    /// Repo publish result (root CID + commands).
    pub repo_output: String,
    /// Vim-style `:` command bar (any bridge op, any tab). A true PTY
    /// terminal is impossible here — the TUI renders from wasm, which
    /// cannot spawn processes — so this is the in-app command line.
    pub cmd_open: bool,
    pub cmd_buffer: String,
    pub cmd_output: String,
}

#[derive(Clone, Copy, Debug, Default, Ord, PartialOrd, Eq, PartialEq)]
pub enum EffectKey {
    #[default]
    ChangeTab,
}

impl<'a> App<'a> {
    pub fn new(title: &'a str, enhanced_graphics: bool) -> Self {
        let mut rand_signal = RandomSignal::new(0, 100);
        let sparkline_points = rand_signal.by_ref().take(300).collect();
        let mut sin_signal = SinSignal::new(0.2, 3.0, 18.0);
        let sin1_points = sin_signal.by_ref().take(100).collect();
        let mut sin_signal2 = SinSignal::new(0.1, 2.0, 10.0);
        let sin2_points = sin_signal2.by_ref().take(200).collect();

        let mut effects = EffectManager::default();
        effects.add_effect(effects::startup());
        effects.add_effect(effects::pulsate_selected_tab());
        App {
            title,
            should_quit: false,
            tabs: TabsState::new(vec![
                "Home", "About", "Status", "Theme", "IPFS", "Peers", "Fetch", "Publish", "Chat",
                "Kubo", "Services", "Git", "Repo",
            ]),
            show_chart: true,
            progress: 0.0,
            sparkline: Signal {
                source: rand_signal,
                points: sparkline_points,
                tick_rate: 1,
            },
            tasks: StatefulList::with_items(TASKS.to_vec()),
            logs: StatefulList::with_items(LOGS.to_vec()),
            signals: Signals {
                sin1: Signal {
                    source: sin_signal,
                    points: sin1_points,
                    tick_rate: 5,
                },
                sin2: Signal {
                    source: sin_signal2,
                    points: sin2_points,
                    tick_rate: 10,
                },
                window: [0.0, 20.0],
            },
            barchart: EVENTS.to_vec(),
            servers: vec![
                Server {
                    name: "NorthAmerica-1",
                    location: "New York City",
                    coords: (40.71, -74.00),
                    status: "Up",
                },
                Server {
                    name: "Europe-1",
                    location: "Paris",
                    coords: (48.85, 2.35),
                    status: "Failure",
                },
                Server {
                    name: "SouthAmerica-1",
                    location: "São Paulo",
                    coords: (-23.54, -46.62),
                    status: "Up",
                },
                Server {
                    name: "Asia-1",
                    location: "Singapore",
                    coords: (1.35, 103.86),
                    status: "Up",
                },
            ],
            enhanced_graphics,
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
            cmd_open: false,
            cmd_buffer: String::new(),
            cmd_output: String::new(),
        }
    }

    pub fn on_up(&mut self) {
        self.tasks.previous();
    }

    pub fn on_down(&mut self) {
        self.tasks.next();
    }

    pub fn on_right(&mut self) {
        self.tabs.next();
        self.add_transition_tab_effect();
    }

    pub fn on_left(&mut self) {
        self.tabs.previous();
        self.add_transition_tab_effect();
    }

    pub fn on_key(&mut self, c: char) {
        match c {
            'q' => {
                self.should_quit = true;
            }
            't' => {
                self.show_chart = !self.show_chart;
            }
            ':' | '\\' => {
                // Vim-style command bar, available on every tab.
                self.cmd_open = true;
                self.cmd_buffer.clear();
            }
            'c' if self.tabs.index == 5 => self.start_input(InputTarget::Connect),
            'f' if self.tabs.index == 6 => self.start_input(InputTarget::Fetch),
            'p' if self.tabs.index == 7 => self.start_input(InputTarget::Publish),
            'm' if self.tabs.index == 8 => self.start_input(InputTarget::Chat),
            'd' if self.tabs.index == 9 => {
                if let Some(id) = ipfs::cmd("kuboDetect", "{}") {
                    self.pending = Some((id, InputTarget::KuboDetect));
                    self.last_result = "detecting kubo (ports 5001-5010)...".to_string();
                }
            }
            'p' if self.tabs.index == 9 => self.start_input(InputTarget::KuboPin),
            'k' if self.tabs.index == 9 => self.start_input(InputTarget::KuboRpc),
            's' if self.tabs.index == 10 => self.start_input(InputTarget::ServicesSet),
            'c' if self.tabs.index == 11 => self.start_input(InputTarget::GitClone),
            'a' if self.tabs.index == 11 => self.start_input(InputTarget::GitAdvertise),
            'p' if self.tabs.index == 12 => {
                if let Some(id) = ipfs::cmd("repo.publishAll", "{}") {
                    self.pending = Some((id, InputTarget::RepoPublish));
                    self.last_result = "publishing repo tree...".to_string();
                }
            }
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
            // Every op reads the fields it needs; supplying the rest as all
            // three covers addr/cid/text-shaped arguments.
            (
                head,
                format!(
                    "{{\"addr\":\"{0}\",\"cid\":\"{0}\",\"text\":\"{0}\",\"rootCid\":\"{0}\"}}",
                    Self::json_escape(&rest_joined)
                ),
            )
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
            InputTarget::KuboDetect => "kuboDetect",
            InputTarget::KuboPin => "kuboPin",
            InputTarget::KuboRpc => "kubo.rpc",
            InputTarget::ServicesSet => "services.set",
            InputTarget::GitClone => "git.clone",
            InputTarget::GitAdvertise => "git.advertise",
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
                    InputTarget::KuboDetect => format!("kubo: {value}"),
                    InputTarget::KuboPin => format!("pinned: {value}"),
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

        // Update progress
        self.progress += 0.001;
        if self.progress > 1.0 {
            self.progress = 0.0;
        }

        self.sparkline.on_tick();
        self.signals.on_tick();

        let log = self.logs.items.pop().unwrap();
        self.logs.items.insert(0, log);

        let event = self.barchart.pop().unwrap();
        self.barchart.insert(0, event);

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
