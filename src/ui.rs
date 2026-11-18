use ratzilla::ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{self, Span},
    widgets::{Block, Paragraph, Wrap},
    Frame,
};
use tachyonfx::Duration;

use crate::app::{App, InputTarget};
use crate::theme;

/// The GitHub chrome: dark app header, repo header (owner/name, Public
/// badge, Watch/Star/Fork), Primer tabnav with the orange active
/// underline, then the active tab's content and the `:` command bar.
pub fn draw(elapsed: Duration, frame: &mut Frame, app: &mut App) {
    let show_cmd_bar = app.cmd_open || !app.cmd_output.is_empty();
    let area = frame.area();
    frame.render_widget(Block::default().style(theme::base()), area);
    let chunks = if show_cmd_bar {
        Layout::vertical([
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(2),
            Constraint::Min(3),
            Constraint::Length(1),
        ])
        .split(area)
    } else {
        Layout::vertical([
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(2),
            Constraint::Min(0),
        ])
        .split(area)
    };
    draw_header(frame, app, chunks[0]);
    draw_repo_header(frame, app, chunks[1]);
    draw_tabnav(frame, app, chunks[2]);
    match app.tabs.index {
        0 => draw_code_tab(frame, app, chunks[3]),
        1 => draw_issues_tab(frame, app, chunks[3]),
        2 => draw_pulls_tab(frame, app, chunks[3]),
        3 => draw_actions_tab(frame, app, chunks[3]),
        4 => draw_projects_tab(frame, app, chunks[3]),
        5 => draw_wiki_tab(frame, app, chunks[3]),
        6 => draw_security_tab(frame, app, chunks[3]),
        7 => draw_insights_tab(frame, app, chunks[3]),
        8 => draw_settings_tab(frame, app, chunks[3]),
        9 => draw_peer_tab(frame, app, chunks[3]),
        10 => draw_publish_tab(frame, app, chunks[3]),
        _ => {}
    };
    let area = frame.area();
    app.effects
        .process_effects(elapsed, frame.buffer_mut(), area);

    if show_cmd_bar {
        let bar = if app.cmd_open {
            format!(":{}_", app.cmd_buffer)
        } else {
            // Last result, one line; the full value stays available via the
            // tab outputs for structured results.
            let trimmed = app.cmd_output.trim();
            let flat: String = trimmed.chars().filter(|c| *c != '\n').collect();
            flat
        };
        let rect = if chunks.len() > 4 { chunks[4] } else { area };
        frame.render_widget(
            Paragraph::new(bar).style(Style::default().fg(theme::FG_MUTED)),
            rect,
        );
    }
}

/// Top-of-page dark bar: app mark + name, the search pill, and the live
/// connection count on the right (GitHub puts utility nav there).
fn draw_header(frame: &mut Frame, app: &App, area: Rect) {
    let inset = Style::default().bg(theme::CANVAS_INSET);
    let snap = &app.ipfs;
    let online = !snap.peer_id.is_empty();
    let (dot, dot_color) = if online {
        ("●", theme::SUCCESS)
    } else {
        ("○", theme::FG_SUBTLE)
    };
    let right = format!("{} connection(s)  ", snap.connections.len());
    let right_width = right.chars().count() + 2;
    let left_width = 2 + app.title.chars().count() + 24;
    let pad = (area.width as usize).saturating_sub(left_width + right_width);
    let line = text::Line::from(vec![
        Span::styled(" ◆ ", inset.fg(theme::ACCENT)),
        Span::styled(
            format!("{:<13}", app.title),
            inset.fg(theme::FG).add_modifier(Modifier::BOLD),
        ),
        Span::styled(" ⌕ Search or jump to… / ", inset.fg(theme::FG_SUBTLE)),
        Span::styled(" ".repeat(pad), inset),
        Span::styled(format!("{dot} "), inset.fg(dot_color)),
        Span::styled(right.trim_end().to_string(), inset.fg(theme::FG_MUTED)),
    ]);
    frame.render_widget(Paragraph::new(line), area);
}

/// `owner / name`, Public badge, then Watch/Star/Fork buttons pushed right.
fn draw_repo_header(frame: &mut Frame, app: &App, area: Rect) {
    let snap = &app.ipfs;
    let (owner, name) = if snap.repo_name.is_empty() {
        ("".to_string(), app.title.to_string())
    } else {
        (snap.repo_owner.clone(), snap.repo_name.clone())
    };
    let mut spans = vec![
        Span::raw(" "),
        Span::styled(owner, Style::default().fg(theme::ACCENT)),
        Span::styled(" / ", Style::default().fg(theme::FG_SUBTLE)),
        Span::styled(
            name.clone(),
            Style::default().fg(theme::FG).add_modifier(Modifier::BOLD),
        ),
        Span::styled("  ", Style::default()),
    ];
    spans.extend(badge_spans("Public"));
    // Right-side buttons: Watch ▾, ☆ Star, ⑃ Fork (GitHub order).
    let buttons = " ▾ Watch   ☆ Star   ⑃ Fork ";
    let used: usize =
        1 + snap.repo_owner.chars().count() + 3 + name.chars().count() + 2 + "Public".len() + 2;
    let pad = (area.width as usize).saturating_sub(used + buttons.chars().count());
    spans.push(Span::styled(" ".repeat(pad), Style::default()));
    spans.extend(theme::btn_spans("▾ Watch"));
    spans.push(Span::raw(" "));
    spans.extend(theme::btn_spans("☆ Star"));
    spans.push(Span::raw(" "));
    spans.extend(theme::btn_spans("⑃ Fork"));
    frame.render_widget(
        Paragraph::new(text::Line::from(spans)).style(theme::base()),
        area,
    );
}

fn badge_spans(label: &str) -> Vec<Span<'static>> {
    vec![
        Span::styled("┌", Style::default().fg(theme::BTN_BORDER)),
        Span::styled(
            format!(" {label} "),
            Style::default()
                .fg(theme::FG_MUTED)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("┐", Style::default().fg(theme::BTN_BORDER)),
    ]
}

/// Primer repo tabnav: a muted top border with the orange underline under
/// the active tab, then the tab titles.
fn draw_tabnav(frame: &mut Frame, app: &App, area: Rect) {
    let widths: Vec<usize> = app.tabs.titles.iter().map(|t| t.len() + 2).collect();
    let mut border_with_gaps = vec![];
    let mut title_spans = vec![];
    for (i, title) in app.tabs.titles.iter().enumerate() {
        let w = widths[i];
        let active = i == app.tabs.index;
        if active {
            border_with_gaps.push(Span::styled(
                "▔".repeat(w),
                Style::default().fg(theme::TAB_UNDERLINE),
            ));
        } else {
            border_with_gaps.push(Span::styled(
                "─".repeat(w),
                Style::default().fg(theme::BORDER_MUTED),
            ));
        }
        title_spans.push(theme::tab(title, active));
        if i + 1 < app.tabs.titles.len() {
            border_with_gaps.push(Span::styled("─", Style::default().fg(theme::BORDER_MUTED)));
            title_spans.push(Span::styled(" ", Style::default()));
        }
    }
    let used: usize = widths.iter().sum::<usize>() + widths.len().saturating_sub(1);
    let fill = (area.width as usize).saturating_sub(used);
    border_with_gaps.push(Span::styled(
        "─".repeat(fill),
        Style::default().fg(theme::BORDER_MUTED),
    ));
    frame.render_widget(
        Paragraph::new(text::Line::from(border_with_gaps)).style(theme::base()),
        Rect::new(area.x, area.y, area.width, 1),
    );
    frame.render_widget(
        Paragraph::new(text::Line::from(title_spans)).style(theme::base()),
        Rect::new(area.x, area.y + 1, area.width, 1),
    );
}

/// Standard tab footer: the input prompt while editing, the last result
/// when there is one, otherwise the idle key hints.
fn footer(app: &App, prompt: &str, idle: &str) -> Paragraph<'static> {
    let text = if app.input_active {
        format!(
            "{prompt}: > {}_   (Enter submits, Esc cancels)",
            app.input_buffer
        )
    } else if app.last_result.is_empty() {
        idle.to_string()
    } else {
        app.last_result.clone()
    };
    Paragraph::new(text).style(Style::default().fg(theme::FG_MUTED))
}

fn content_block(title: &str) -> Block<'static> {
    theme::block(title)
}

// ---- Code -----------------------------------------------------------------

fn draw_code_tab(frame: &mut Frame, app: &mut App, area: Rect) {
    let chunks = Layout::vertical([Constraint::Min(3), Constraint::Length(2)]).split(area);
    let body = if app.repo_output.is_empty() {
        "(repo not published — press p to add the whole repo tree to IPFS and advertise it)"
    } else {
        app.repo_output.as_str()
    };
    frame.render_widget(
        Paragraph::new(body)
            .block(content_block("Code"))
            .wrap(Wrap { trim: false }),
        chunks[0],
    );
    frame.render_widget(
        footer(app, "publish", "p = publish repo tree to IPFS"),
        chunks[1],
    );
}

// ---- Issues ---------------------------------------------------------------

fn draw_issues_tab(frame: &mut Frame, app: &mut App, area: Rect) {
    let chunks = Layout::vertical([Constraint::Min(3), Constraint::Length(2)]).split(area);
    let issues = &app.ipfs.issues;
    let mut lines = vec![];
    if issues.is_empty() {
        lines.push(text::Line::from(
            "(no issues — press i to file one; s syncs from the index IPNS name)",
        ));
    } else {
        for issue in issues {
            lines.push(text::Line::from(format!(
                "{} {} {}",
                issue.timestamp, issue.title, issue.cid
            )));
        }
    }
    frame.render_widget(
        Paragraph::new(lines)
            .block(content_block(&format!("Issues ({} in view)", issues.len())))
            .wrap(Wrap { trim: false }),
        chunks[0],
    );
    frame.render_widget(
        footer(app, "file issue", "i = file issue   s = sync from IPNS"),
        chunks[1],
    );
}

// ---- Pulls ----------------------------------------------------------------

fn draw_pulls_tab(frame: &mut Frame, app: &mut App, area: Rect) {
    let chunks = Layout::vertical([Constraint::Min(3), Constraint::Length(2)]).split(area);
    let snap = &app.ipfs;
    let mut lines = vec![
        text::Line::from(
            "Clone a repo through the app: fetch a bare-repo-shaped CID tree, get a zip with .git/ reconstructed.",
        ),
        text::Line::from(
            "Live clone: s = isomorphic-git clone (persists in-browser)   u = pull newer CID   l = list clones",
        ),
        text::Line::from(""),
        text::Line::from(format!(
            "Serve advertisements seen: {}{}",
            snap.git_seen,
            if snap.serving { " (we are advertising)" } else { "" }
        )),
    ];
    if !app.last_result.is_empty() {
        lines.push(text::Line::from(""));
        lines.push(text::Line::from(app.last_result.as_str()));
    }
    frame.render_widget(
        Paragraph::new(lines)
            .block(content_block("Pull requests"))
            .wrap(Wrap { trim: false }),
        chunks[0],
    );
    let footer = if app.input_active {
        match app.input_target {
            InputTarget::GitClone => format!(
                "clone CID: > {}_   (Enter clones to zip, Esc cancels)",
                app.input_buffer
            ),
            InputTarget::GitCloneSmart => format!(
                "live clone CID: > {}_   (Enter clones in-browser, Esc cancels)",
                app.input_buffer
            ),
            InputTarget::GitPullSmart => format!(
                "pull CID: > {}_   (Enter pulls newer state, Esc cancels)",
                app.input_buffer
            ),
            _ => format!(
                "advertise CID: > {}_   (Enter publishes serve envelope, Esc cancels)",
                app.input_buffer
            ),
        }
    } else {
        "c = clone zip   s = live clone   u = pull   a = advertise   l = list clones".to_string()
    };
    frame.render_widget(
        Paragraph::new(footer).style(Style::default().fg(theme::FG_MUTED)),
        chunks[1],
    );
}

// ---- Actions / Projects / Security (web-app parity gaps) ------------------

fn draw_actions_tab(frame: &mut Frame, app: &mut App, area: Rect) {
    draw_placeholder_tab(
        frame,
        app,
        area,
        "Actions",
        &[
            "GitHub Actions run CI on the git host; nothing executes in-page.",
            "The bridge does not expose workflow runs yet — this tab is the",
            "placeholder the web app maps: Actions ↔ CI logs, still a gap.",
        ],
    );
}

fn draw_projects_tab(frame: &mut Frame, app: &mut App, area: Rect) {
    draw_placeholder_tab(
        frame,
        app,
        area,
        "Projects",
        &[
            "Projects (milestones) live in the web app — issues are one-click",
            "importable there. The TUI shows the milestone list once the",
            "bridge exposes it.",
        ],
    );
}

fn draw_security_tab(frame: &mut Frame, app: &mut App, area: Rect) {
    draw_placeholder_tab(
        frame,
        app,
        area,
        "Security",
        &[
            "Notes and chat are P7-signed dag-json (Ed25519) — the ✓/✗ on",
            "chat rows is the verification flag. Policy, advisories, and the",
            "peer blocklist live in the web app.",
        ],
    );
}

fn draw_placeholder_tab(frame: &mut Frame, app: &App, area: Rect, title: &str, note: &[&str]) {
    let chunks = Layout::vertical([Constraint::Min(3), Constraint::Length(2)]).split(area);
    let mut lines: Vec<text::Line> = note.iter().map(|l| text::Line::from(*l)).collect();
    if !app.last_result.is_empty() {
        lines.push(text::Line::from(""));
        lines.push(text::Line::from(app.last_result.as_str()));
    }
    frame.render_widget(
        Paragraph::new(lines)
            .block(content_block(title))
            .wrap(Wrap { trim: false }),
        chunks[0],
    );
    frame.render_widget(
        Paragraph::new("").style(Style::default().fg(theme::FG_MUTED)),
        chunks[1],
    );
}

// ---- Wiki (CID content reading) --------------------------------------------

fn draw_wiki_tab(frame: &mut Frame, app: &mut App, area: Rect) {
    let chunks = Layout::vertical([Constraint::Min(3), Constraint::Length(2)]).split(area);
    let body = if app.fetch_output.is_empty() {
        "(no content fetched — press f and enter a CID)"
    } else {
        app.fetch_output.as_str()
    };
    frame.render_widget(
        Paragraph::new(body)
            .block(content_block("Wiki"))
            .wrap(Wrap { trim: false }),
        chunks[0],
    );
    frame.render_widget(
        footer(app, "fetch CID", "f = fetch CID for reading"),
        chunks[1],
    );
}

// ---- Insights (node / Kubo / services status) ------------------------------

fn draw_insights_tab(frame: &mut Frame, app: &mut App, area: Rect) {
    let snap = &app.ipfs;
    let mut lines = vec![
        text::Line::from(format!("Status: {}", snap.node_status)),
        text::Line::from(format!("Peer ID: {}", snap.peer_id)),
        text::Line::from(format!("Connections: {}", snap.connections.len())),
        text::Line::from(""),
        text::Line::from(format!("Kubo: {}", snap.kubo_status)),
        text::Line::from(format!("Kubo endpoint: {}", snap.kubo_endpoint)),
        text::Line::from(format!("Kubo peer ID: {}", snap.kubo_peer_id)),
        text::Line::from(""),
        text::Line::from(format!(
            "Git serve adverts seen: {}{}",
            snap.git_seen,
            if snap.serving { " (serving)" } else { "" }
        )),
        text::Line::from(""),
        text::Line::from("Multiaddrs:"),
    ];
    if snap.multiaddrs.is_empty() {
        lines.push(text::Line::from("(none - browser node)"));
    } else {
        for addr in &snap.multiaddrs {
            lines.push(text::Line::from(addr.as_str()));
        }
    }
    let paragraph = Paragraph::new(lines)
        .block(content_block("Insights"))
        .wrap(Wrap { trim: false });
    frame.render_widget(paragraph, area);
}

// ---- Settings (optional services) ------------------------------------------

fn draw_settings_tab(frame: &mut Frame, app: &mut App, area: Rect) {
    let chunks = Layout::vertical([Constraint::Min(3), Constraint::Length(2)]).split(area);
    let names = &app.ipfs.service_names;
    let mut lines = vec![
        text::Line::from(
            "Optional service endpoints (docs/optional-services.md) — the p2p path works with none configured.",
        ),
        text::Line::from(""),
    ];
    if names.is_empty() {
        lines.push(text::Line::from(
            "(none configured — public defaults in use)",
        ));
    } else {
        for name in names {
            lines.push(text::Line::from(format!("• {name}")));
        }
    }
    if !app.last_result.is_empty() {
        lines.push(text::Line::from(""));
        lines.push(text::Line::from(app.last_result.as_str()));
    }
    frame.render_widget(
        Paragraph::new(lines)
            .block(content_block("Settings"))
            .wrap(Wrap { trim: false }),
        chunks[0],
    );
    frame.render_widget(
        footer(
            app,
            "set services JSON array",
            "s = set services (paste a JSON array, e.g. [{\"name\":\"gnostr.org\",\"gateways\":[...]}])",
        ),
        chunks[1],
    );
}

// ---- Peer (connections + gossipsub chat) -----------------------------------

fn draw_peer_tab(frame: &mut Frame, app: &mut App, area: Rect) {
    let chunks = Layout::vertical([
        Constraint::Percentage(45),
        Constraint::Min(3),
        Constraint::Length(2),
    ])
    .split(area);
    let snap = &app.ipfs;
    let mut peer_lines = vec![];
    if snap.connections.is_empty() {
        peer_lines.push(text::Line::from(
            "(no connections — press c to dial a multiaddr)",
        ));
    } else {
        for conn in &snap.connections {
            peer_lines.push(text::Line::from(format!(
                "{} [{}] {}",
                conn.peer, conn.direction, conn.addr
            )));
        }
    }
    frame.render_widget(
        Paragraph::new(peer_lines)
            .block(content_block(&format!(
                "Peers ({} connected)",
                snap.connections.len()
            )))
            .wrap(Wrap { trim: false }),
        chunks[0],
    );
    let inbox = &app.ipfs.chat_inbox;
    let mut chat_lines = vec![];
    if inbox.is_empty() {
        chat_lines.push(text::Line::from("(no messages — press m to send one)"));
    } else {
        for msg in inbox.iter().rev() {
            // Oldest first so the newest sits at the bottom.
            let mark = if msg.verified { "✓" } else { "✗" };
            chat_lines.push(text::Line::from(format!(
                "{} {} {}: {}",
                mark, msg.timestamp, msg.signer, msg.text
            )));
        }
    }
    frame.render_widget(
        Paragraph::new(chat_lines)
            .block(content_block(&format!("Chat ({} message(s))", inbox.len())))
            .wrap(Wrap { trim: false }),
        chunks[1],
    );
    let footer = if app.input_active {
        match app.input_target {
            InputTarget::Connect => format!(
                "connect: > {}_   (Enter dials, Esc cancels)",
                app.input_buffer
            ),
            _ => format!("chat: > {}_   (Enter sends, Esc cancels)", app.input_buffer),
        }
    } else if app.last_result.is_empty() {
        "c = connect   m = chat message".to_string()
    } else {
        app.last_result.clone()
    };
    frame.render_widget(
        Paragraph::new(footer).style(Style::default().fg(theme::FG_MUTED)),
        chunks[2],
    );
}

// ---- Publish ---------------------------------------------------------------

fn draw_publish_tab(frame: &mut Frame, app: &mut App, area: Rect) {
    let chunks = Layout::vertical([Constraint::Min(3), Constraint::Length(2)]).split(area);
    let body = if app.publish_output.is_empty() {
        "(nothing published — press p and enter text)"
    } else {
        app.publish_output.as_str()
    };
    frame.render_widget(
        Paragraph::new(body)
            .block(content_block("Publish"))
            .wrap(Wrap { trim: false }),
        chunks[0],
    );
    frame.render_widget(footer(app, "publish text", "p = publish text"), chunks[1]);
}
