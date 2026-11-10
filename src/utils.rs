use crate::backend::BackendType;
use ratzilla::web_sys;
use wasm_bindgen::JsValue;

/// Inject HTML footer with backend switching links
///
/// NOTE (page-layout contract): this footer is `position: fixed; bottom: 0;
/// z-index: 1000` and ~33px tall. Layout inside: IPFS connection status on
/// the LEFT (`#ratzilla-ipfs-status`, written at runtime by js/ipfs-node.js
/// via a MutationObserver — wasm and JS race, never assume order), backend
/// switcher links + FPS on the RIGHT. index-rust.html does NOT have its own
/// status bar; this footer is the only chrome. If the footer's height or
/// z-index changes, update the CSS contract documented in src/main.rs.
pub(crate) fn inject_backend_footer(current_backend: BackendType) -> Result<(), JsValue> {
    let window = web_sys::window().ok_or("No window")?;
    let document = window.document().ok_or("No document")?;

    // Remove existing footer if present
    if let Some(existing) = document.get_element_by_id("ratzilla-backend-footer") {
        existing.remove();
    }

    // Create footer element
    let footer = document.create_element("div")?;
    footer.set_id("ratzilla-backend-footer");

    // Set footer styles
    footer.set_attribute(
        "style",
        "position: fixed; bottom: 0; left: 0; right: 0; \
         background: rgba(0,0,0,0.8); color: white; \
         padding: 8px 16px; font-family: monospace; font-size: 12px; \
         display: flex; justify-content: space-between; align-items: center; gap: 16px; \
         border-top: 1px solid #333; z-index: 1000;",
    )?;

    // Get current URL without backend param - use relative URL to avoid protocol issues
    let location = window.location();
    let base_url = location.pathname().unwrap_or_default();

    let backends = [BackendType::Dom, BackendType::Canvas, BackendType::WebGl2];
    let mut links = Vec::new();

    for backend in backends {
        let is_current = backend == current_backend;
        let style = if is_current {
            "color: #4ade80; font-weight: bold; text-decoration: none;"
        } else {
            "color: #94a3b8; text-decoration: none; cursor: pointer;"
        };

        let link = if is_current {
            format!("<span style=\"{}\">● {backend}</span>", style,)
        } else {
            format!(
                "<a href=\"{}?backend={}\" style=\"{}\">{backend}</a>",
                base_url,
                backend.as_str(),
                style,
            )
        };

        links.push(link);
    }

    let footer_html = format!(
        "<span id=\"ratzilla-ipfs-status\" style=\"color: #9e9e9e;\">IPFS: starting...</span>\
         <span style=\"display: flex; gap: 16px; align-items: center;\">\
         <span style=\"display: none;\"><span style=\"color: #64748b;\">Backend:</span> {}</span>\
         <span><span style=\"color: #64748b;\">FPS:</span> \
         <span id=\"ratzilla-fps\" style=\"color: #4ade80; font-weight: bold;\">--</span></span>\
         </span>",
        links.join(" | ")
    );

    footer.set_inner_html(&footer_html);

    // Append to body
    let body = document.body().ok_or("No body")?;
    body.append_child(&footer)?;

    Ok(())
}
