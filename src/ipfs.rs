//! Bridge to the JS IPFS backend (js/ipfs-node.js) — see
//! docs/rust-js-bridge.md. Two channels, both plain js-sys:
//!
//! - [`poll`]: reads `window.__ipfsState` into a typed [`Snapshot`].
//!   Defensive everywhere — the JS module owns the object shape and may
//!   lag behind this struct during refactors; a missing field yields a
//!   default, never a panic.
//! - [`cmd`]: calls `window.__ipfsCmd(id, op, arg_json)`; the JS side runs
//!   the op async and writes `{ ok, value|error }` into
//!   `__ipfsState.results[id]`. [`take_result`] reads and deletes it.
//!
//! Compile-checked on every target: the wasm32 implementation talks to the
//! browser; elsewhere the same API is a no-op stub so `cargo check
//! --features bundle-wry` on a native host still builds.

#[cfg(target_arch = "wasm32")]
mod imp {
    use js_sys::{Reflect, JSON};
    use wasm_bindgen::{JsCast, JsValue};

    #[derive(Clone, Debug, Default)]
    pub struct Connection {
        pub peer: String,
        pub addr: String,
        pub direction: String,
    }

    #[derive(Clone, Debug, Default)]
    pub struct ChatMessage {
        pub signer: String,
        pub verified: bool,
        pub text: String,
        pub timestamp: String,
    }

    #[derive(Clone, Debug, Default)]
    pub struct Snapshot {
        pub node_status: String,
        pub peer_id: String,
        pub multiaddrs: Vec<String>,
        pub connections: Vec<Connection>,
        pub chat_inbox: Vec<ChatMessage>,
        pub kubo_status: String,
        pub kubo_endpoint: String,
        pub git_seen: usize,
        pub serving: bool,
    }

    fn window() -> JsValue {
        js_sys::global().into()
    }

    fn get_string(obj: &JsValue, key: &str) -> String {
        Reflect::get(obj, &JsValue::from_str(key))
            .ok()
            .and_then(|v| v.as_string())
            .unwrap_or_default()
    }

    fn get_bool(obj: &JsValue, key: &str) -> bool {
        Reflect::get(obj, &JsValue::from_str(key))
            .ok()
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }

    fn get_array(obj: &JsValue, key: &str) -> Vec<JsValue> {
        Reflect::get(obj, &JsValue::from_str(key))
            .ok()
            .and_then(|v| v.dyn_into::<js_sys::Array>().ok())
            .map(|a| a.to_vec())
            .unwrap_or_default()
    }

    /// Read the current `window.__ipfsState`.
    pub fn poll() -> Snapshot {
        let mut snap = Snapshot::default();
        let state =
            Reflect::get(&window(), &JsValue::from_str("__ipfsState")).unwrap_or(JsValue::NULL);
        if !state.is_object() || state.is_null() {
            return snap;
        }

        if let Ok(node) = Reflect::get(&state, &JsValue::from_str("node")) {
            snap.node_status = get_string(&node, "status");
            snap.peer_id = get_string(&node, "peerId");
            snap.multiaddrs = get_array(&node, "multiaddrs")
                .into_iter()
                .filter_map(|v| v.as_string())
                .collect();
            snap.connections = get_array(&node, "connections")
                .into_iter()
                .filter_map(|c| {
                    if !c.is_object() {
                        return None;
                    }
                    Some(Connection {
                        peer: get_string(&c, "peer"),
                        addr: get_string(&c, "addr"),
                        direction: get_string(&c, "direction"),
                    })
                })
                .collect();
        }

        if let Ok(chat) = Reflect::get(&state, &JsValue::from_str("chat")) {
            snap.chat_inbox = get_array(&chat, "inbox")
                .into_iter()
                .filter_map(|m| {
                    if !m.is_object() {
                        return None;
                    }
                    Some(ChatMessage {
                        signer: get_string(&m, "signer"),
                        verified: get_bool(&m, "verified"),
                        text: get_string(&m, "text"),
                        timestamp: get_string(&m, "timestamp"),
                    })
                })
                .collect();
        }

        if let Ok(kubo) = Reflect::get(&state, &JsValue::from_str("kubo")) {
            snap.kubo_status = get_string(&kubo, "status");
            snap.kubo_endpoint = get_string(&kubo, "endpoint");
        }

        if let Ok(git) = Reflect::get(&state, &JsValue::from_str("git")) {
            snap.git_seen = get_array(&git, "seen").len();
            snap.serving = Reflect::get(&git, &JsValue::from_str("serving"))
                .ok()
                .map(|v| !v.is_null() && !v.is_undefined())
                .unwrap_or(false);
        }

        snap
    }

    /// Send a command; returns the id Rust can later `take_result` for.
    /// `arg_json` must be a JSON text (use "{}" for no argument).
    pub fn cmd(op: &str, arg_json: &str) -> Option<u64> {
        let win = window();
        let cmd_fn = Reflect::get(&win, &JsValue::from_str("__ipfsCmd")).ok()?;
        if !cmd_fn.is_function() {
            return None;
        }
        let arg = JSON::parse(arg_json).unwrap_or_else(|_| JsValue::from_str("{}"));
        static mut NEXT_ID: u64 = 1;
        // SAFETY: single-threaded wasm main loop; ids only need uniqueness
        // per page session.
        let id = unsafe {
            NEXT_ID += 1;
            NEXT_ID
        };
        let _ = js_sys::Function::from(cmd_fn).call3(
            &win,
            &JsValue::from_f64(id as f64),
            &JsValue::from_str(op),
            &arg,
        );
        Some(id)
    }

    /// Read and remove a command result. Ok = JSON-stringified `value`,
    /// Err = the error string. Unknown/absent id yields None (still
    /// pending or already taken).
    pub fn take_result(id: u64) -> Option<Result<String, String>> {
        let win = window();
        let state = Reflect::get(&win, &JsValue::from_str("__ipfsState")).ok()?;
        let results = Reflect::get(&state, &JsValue::from_str("results")).ok()?;
        let key = JsValue::from_f64(id as f64);
        let entry = Reflect::get(&results, &key).ok()?;
        if entry.is_undefined() || entry.is_null() {
            return None;
        }
        let results_obj: js_sys::Object = results.dyn_into().ok()?;
        Reflect::delete_property(&results_obj, &key).ok()?;
        let ok = entry
            .dyn_ref::<js_sys::Object>()
            .and_then(|o| Reflect::get(o, &JsValue::from_str("ok")).ok())
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if ok {
            let value = Reflect::get(&entry, &JsValue::from_str("value")).ok()?;
            let text = if value.is_string() {
                value.as_string().unwrap_or_default()
            } else {
                JSON::stringify(&value)
                    .ok()
                    .and_then(|s| s.as_string())
                    .unwrap_or_default()
            };
            Some(Ok(text))
        } else {
            Some(Err(get_string(&entry, "error")))
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod imp {
    #[derive(Clone, Debug, Default)]
    pub struct Connection {
        pub peer: String,
        pub addr: String,
        pub direction: String,
    }

    #[derive(Clone, Debug, Default)]
    pub struct ChatMessage {
        pub signer: String,
        pub verified: bool,
        pub text: String,
        pub timestamp: String,
    }

    #[derive(Clone, Debug, Default)]
    pub struct Snapshot {
        pub node_status: String,
        pub peer_id: String,
        pub multiaddrs: Vec<String>,
        pub connections: Vec<Connection>,
        pub chat_inbox: Vec<ChatMessage>,
        pub kubo_status: String,
        pub kubo_endpoint: String,
        pub git_seen: usize,
        pub serving: bool,
    }

    pub fn poll() -> Snapshot {
        Snapshot::default()
    }

    pub fn cmd(_op: &str, _arg_json: &str) -> Option<u64> {
        None
    }

    pub fn take_result(_id: u64) -> Option<Result<String, String>> {
        None
    }
}

pub use imp::{cmd, poll, take_result, ChatMessage, Connection, Snapshot};
