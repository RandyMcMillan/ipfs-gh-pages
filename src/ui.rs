use ratzilla::ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{self, Span},
    widgets::{Block, Cell, Paragraph, Row, Table, Wrap},
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

/// GitHub's Code tab: branch bar, latest-commit line, the file listing,
/// then the clone box (after publish) and the README, with the key hints
/// in the footer.
fn draw_code_tab(frame: &mut Frame, app: &mut App, area: Rect) {
    let show_clone = !app.repo_output.is_empty();
    let show_readme = !app.ipfs.repo_readme.is_empty();
    let mut constraints = vec![
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Min(5),
    ];
    if show_clone {
        constraints.push(Constraint::Length(7));
    }
    if show_readme {
        constraints.push(Constraint::Min(4));
    }
    constraints.push(Constraint::Length(2));
    let chunks = Layout::vertical(constraints).split(area);
    let mut i = 0;
    draw_branch_bar(frame, app, chunks[i]);
    i += 1;
    draw_commit_bar(frame, app, chunks[i]);
    i += 1;
    draw_file_table(frame, app, chunks[i]);
    i += 1;
    if show_clone {
        frame.render_widget(
            Paragraph::new(app.repo_output.as_str())
                .block(content_block("Clone from IPFS"))
                .wrap(Wrap { trim: false }),
            chunks[i],
        );
        i += 1;
    }
    if show_readme {
        let lines = readme_lines(&app.ipfs.repo_readme);
        frame.render_widget(
            Paragraph::new(lines)
                .block(content_block("README.md"))
                .wrap(Wrap { trim: false }),
            chunks[i],
        );
        i += 1;
    }
    frame.render_widget(
        footer(
            app,
            "publish",
            "↑/↓ = move   Enter = expand/collapse   ⌫ = collapse all   p = publish repo tree",
        ),
        chunks[i],
    );
}

/// GitHub-flavored README rendering, line-based (terminal markdown à la
/// glow/mdcat): ATX headers bold (h1 accent), fenced code blocks on the
/// inset background, quotes muted behind a bar, rules as hairlines.
/// Inline formatting stays literal — no span-level parsing.
fn readme_lines(readme: &str) -> Vec<text::Line<'static>> {
    let mut lines = vec![];
    let mut in_code = false;
    for raw in readme.lines().take(200) {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_code = !in_code;
            continue;
        }
        if in_code {
            lines.push(text::Line::from(Span::styled(
                format!(" {line}"),
                Style::default().fg(theme::FG_MUTED).bg(theme::CANVAS_INSET),
            )));
        } else if let Some(header) = trimmed.strip_prefix("### ") {
            lines.push(text::Line::from(Span::styled(
                header.to_string(),
                Style::default()
                    .fg(theme::FG)
                    .add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
            )));
        } else if let Some(header) = trimmed.strip_prefix("## ") {
            lines.push(text::Line::from(Span::styled(
                header.to_string(),
                Style::default()
                    .fg(theme::FG)
                    .add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
            )));
        } else if let Some(header) = trimmed.strip_prefix("# ") {
            lines.push(text::Line::from(Span::styled(
                header.to_string(),
                Style::default()
                    .fg(theme::ACCENT)
                    .add_modifier(Modifier::BOLD),
            )));
        } else if let Some(quote) = trimmed.strip_prefix("> ") {
            lines.push(text::Line::from(vec![
                Span::styled(" ▎", Style::default().fg(theme::ACCENT)),
                Span::styled(quote.to_string(), Style::default().fg(theme::FG_MUTED)),
            ]));
        } else if trimmed == "---" || trimmed == "***" || trimmed == "___" {
            lines.push(text::Line::from(Span::styled(
                "─".repeat(40),
                Style::default().fg(theme::BORDER),
            )));
        } else {
            lines.push(text::Line::from(line.to_string()));
        }
    }
    lines
}

/// ` ⎇ main ▾   Go to file …                     + Add file ▾  [ Code ▾ ] `
fn draw_branch_bar(frame: &mut Frame, app: &App, area: Rect) {
    let snap = &app.ipfs;
    let branch = if snap.repo_branch.is_empty() {
        "main"
    } else {
        snap.repo_branch.as_str()
    };
    let mut spans = vec![
        Span::styled(" ⎇ ", Style::default().fg(theme::FG)),
        Span::styled(
            format!(" {branch} ▾ "),
            Style::default().bg(theme::BTN_BG).fg(theme::FG_MUTED),
        ),
        Span::raw("  "),
        Span::styled(
            " Go to file ",
            Style::default().bg(theme::BTN_BG).fg(theme::FG_SUBTLE),
        ),
    ];
    let right = " + Add file ▾   Code ▾ ";
    let left_width = 3 + branch.chars().count() + 4 + 2 + " Go to file ".len();
    let pad = (area.width as usize).saturating_sub(left_width + right.chars().count());
    spans.push(Span::styled(" ".repeat(pad), Style::default()));
    spans.push(Span::styled(
        " + Add file ▾ ",
        Style::default().bg(theme::BTN_BG).fg(theme::FG_MUTED),
    ));
    spans.push(Span::raw(" "));
    spans.push(Span::styled(
        " Code ▾ ",
        Style::default()
            .bg(theme::PRIMARY)
            .fg(theme::ON_PRIMARY)
            .add_modifier(Modifier::BOLD),
    ));
    frame.render_widget(
        Paragraph::new(text::Line::from(spans)).style(theme::base()),
        area,
    );
}

/// Latest-commit line above the listing: dot, message, sha, age, count.
fn draw_commit_bar(frame: &mut Frame, app: &App, area: Rect) {
    let snap = &app.ipfs;
    let (msg, meta) = if snap.repo_last_commit.is_empty() {
        (
            "(no commit metadata — rebuild the bridge bundle: node scripts/build-ipfs-js.mjs)"
                .to_string(),
            String::new(),
        )
    } else {
        let mut meta = snap.repo_short_sha.clone();
        if !snap.repo_last_commit_time.is_empty() {
            meta.push_str(" · ");
            meta.push_str(&snap.repo_last_commit_time);
        }
        if !snap.repo_commit_count.is_empty() {
            meta.push_str(&format!(" · {} commits", snap.repo_commit_count));
        }
        (snap.repo_last_commit.clone(), meta)
    };
    let msg_width = msg.chars().count() + 4;
    let meta_width = meta.chars().count();
    let pad = (area.width as usize).saturating_sub(msg_width + meta_width);
    let mut spans = vec![
        Span::styled(" ● ", Style::default().fg(theme::SUCCESS)),
        Span::styled(msg, Style::default().fg(theme::FG)),
    ];
    if !meta.is_empty() {
        spans.push(Span::styled(" ".repeat(pad), Style::default()));
        spans.push(Span::styled(meta, Style::default().fg(theme::FG_MUTED)));
    }
    frame.render_widget(
        Paragraph::new(text::Line::from(spans)).style(theme::base()),
        area,
    );
}

/// The repo file tree: immediate children of the current directory
/// (dirs first, accent, trailing `/`), cursor-highlighted like GitHub's
/// hover, breadcrumb in the panel title.
fn draw_file_table(frame: &mut Frame, app: &mut App, area: Rect) {
    let entries = app.code_tree_rows();
    let total = app.ipfs.repo_files.len();
    let cursor = app.tree_cursor.min(entries.len().saturating_sub(1));
    // GitHub's row hover: a hair lighter than the canvas.
    let hover = Style::default().bg(Color::Rgb(0x16, 0x1b, 0x22));
    let mut rows: Vec<Row> = vec![];
    if entries.is_empty() {
        rows.push(Row::new(vec![Cell::from(Span::styled(
            if total == 0 {
                "(repo file listing unavailable — the bridge bundle predates REPO_FILES; rebuild: node scripts/build-ipfs-js.mjs)"
            } else {
                "(empty directory)"
            },
            Style::default().fg(theme::FG_MUTED),
        ))]));
    }
    for (i, entry) in entries.iter().enumerate() {
        let selected = i == cursor;
        // serie-style guides: connectors subtle, names carrying the color.
        let guide = Span::styled(entry.prefix.clone(), Style::default().fg(theme::FG_SUBTLE));
        let name = if entry.is_dir {
            let marker = if app.open_dirs.contains(&entry.path) {
                "▾ "
            } else {
                "▸ "
            };
            Span::styled(
                format!("{marker}{}/", entry.name),
                Style::default()
                    .fg(theme::ACCENT)
                    .add_modifier(Modifier::BOLD),
            )
        } else {
            Span::styled(entry.name.clone(), Style::default().fg(theme::FG))
        };
        let style = if selected { hover } else { Style::default() };
        rows.push(
            Row::new(vec![
                Cell::from(Span::styled(
                    " ",
                    if selected { hover } else { Style::default() },
                )),
                Cell::from(guide),
                Cell::from(name),
            ])
            .style(style),
        );
    }
    let title = if app.open_dirs.is_empty() {
        format!("Files ({} path(s))", total)
    } else {
        format!(
            "Files ({} path(s), {} expanded)",
            total,
            app.open_dirs.len()
        )
    };
    let table = Table::new(
        rows,
        [
            Constraint::Length(1),
            Constraint::Length(28),
            Constraint::Min(10),
        ],
    )
    .block(content_block(&title))
    .style(theme::base());
    frame.render_widget(table, area);
}

// ---- Issues ---------------------------------------------------------------

fn draw_issues_tab(frame: &mut Frame, app: &mut App, area: Rect) {
    let outer = Layout::vertical([Constraint::Min(3), Constraint::Length(2)]).split(area);
    let panes = Layout::horizontal([Constraint::Percentage(55), Constraint::Percentage(45)])
        .split(outer[0]);
    let issues = &app.ipfs.issues;
    let cursor = app.issue_cursor.min(issues.len().saturating_sub(1));
    // GitHub's row hover: a hair lighter than the canvas.
    let hover = Style::default().bg(Color::Rgb(0x16, 0x1b, 0x22));
    let mut lines = vec![];
    if issues.is_empty() {
        lines.push(text::Line::from(
            "(no issues — press i to file one; s syncs from the index IPNS name)",
        ));
    } else {
        for (i, issue) in issues.iter().enumerate() {
            // GitHub issue row: #N (accent) title (default) meta (muted).
            let selected = i == cursor;
            let num_style = Style::default()
                .fg(theme::ACCENT)
                .add_modifier(Modifier::BOLD);
            let num_style = if selected {
                hover.patch(num_style)
            } else {
                num_style
            };
            let title_style = if selected {
                hover.patch(Style::default().fg(theme::FG))
            } else {
                Style::default().fg(theme::FG)
            };
            lines.push(text::Line::from(vec![
                Span::styled(format!(" #{}  ", issues.len() - i), num_style),
                Span::styled(issue.title.clone(), title_style),
                Span::styled(
                    format!("  {}  ", issue.timestamp),
                    Style::default().fg(theme::FG_MUTED),
                ),
                Span::styled(issue.cid.clone(), Style::default().fg(theme::FG_SUBTLE)),
            ]));
        }
    }
    frame.render_widget(
        Paragraph::new(lines)
            .block(content_block(&format!("Issues ({} in view)", issues.len())))
            .wrap(Wrap { trim: false }),
        panes[0],
    );
    // Detail pane (GitKraken-style right panel): the selected issue's
    // full values, unwrapped.
    let detail: Vec<text::Line> = match issues.get(cursor) {
        Some(issue) => vec![
            text::Line::from(vec![Span::styled(
                format!("Issue #{}", issues.len() - cursor),
                Style::default()
                    .fg(theme::ACCENT)
                    .add_modifier(Modifier::BOLD),
            )]),
            text::Line::from(""),
            text::Line::from(vec![
                Span::styled("Title  ", Style::default().fg(theme::FG_MUTED)),
                Span::styled(issue.title.clone(), Style::default().fg(theme::FG)),
            ]),
            text::Line::from(vec![
                Span::styled("CID  ", Style::default().fg(theme::FG_MUTED)),
                Span::styled(issue.cid.clone(), Style::default().fg(theme::FG)),
            ]),
            text::Line::from(vec![
                Span::styled("Time  ", Style::default().fg(theme::FG_MUTED)),
                Span::styled(issue.timestamp.clone(), Style::default().fg(theme::FG)),
            ]),
        ],
        None => vec![text::Line::from(Span::styled(
            "(select an issue to see its full values)",
            Style::default().fg(theme::FG_MUTED),
        ))],
    };
    frame.render_widget(
        Paragraph::new(detail)
            .block(content_block("Issue"))
            .wrap(Wrap { trim: true }),
        panes[1],
    );
    frame.render_widget(
        footer(
            app,
            "file issue",
            "↑/↓/j/k = move   i = file issue   s = sync from IPNS",
        ),
        outer[1],
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
    let outer = Layout::vertical([Constraint::Min(3), Constraint::Length(2)]).split(area);
    let panes = Layout::horizontal([Constraint::Percentage(40), Constraint::Percentage(60)])
        .split(outer[0]);
    let workflows = &app.ipfs.workflows;
    let cursor = app.wf_cursor.min(workflows.len().saturating_sub(1));
    let hover = Style::default().bg(Color::Rgb(0x16, 0x1b, 0x22));

    // Left pane: the workflow list (wrkflw's Workflows view).
    let mut lines = vec![];
    if workflows.is_empty() {
        lines.push(text::Line::from(
            "(no workflows under .github/workflows — this repo defines none)",
        ));
    }
    for (i, wf) in workflows.iter().enumerate() {
        let selected = i == cursor;
        let name_style = if selected {
            hover.patch(Style::default().fg(theme::FG).add_modifier(Modifier::BOLD))
        } else {
            Style::default().fg(theme::FG)
        };
        lines.push(text::Line::from(vec![
            Span::styled(wf.name.clone(), name_style),
            Span::styled(
                format!("  {}  ", wf.file),
                Style::default().fg(theme::FG_SUBTLE),
            ),
            Span::styled(
                format!("{} job(s)", wf.jobs.len()),
                Style::default().fg(theme::FG_MUTED),
            ),
        ]));
    }
    frame.render_widget(
        Paragraph::new(lines)
            .block(content_block(&format!("Workflows ({})", workflows.len())))
            .wrap(Wrap { trim: false }),
        panes[0],
    );

    // Right pane: the selected workflow's jobs (wrkflw's Run view).
    let mut rows: Vec<Row> = vec![];
    if let Some(wf) = workflows.get(cursor) {
        for job in &wf.jobs {
            rows.push(Row::new(vec![
                Cell::from(Span::styled(
                    job.name.clone(),
                    Style::default()
                        .fg(theme::ACCENT)
                        .add_modifier(Modifier::BOLD),
                )),
                Cell::from(Span::styled(
                    job.runs_on.clone(),
                    Style::default().fg(theme::FG_MUTED),
                )),
                Cell::from(Span::styled(
                    if job.needs.is_empty() {
                        "—".to_string()
                    } else {
                        job.needs.clone()
                    },
                    Style::default().fg(theme::FG),
                )),
            ]));
        }
    }
    if rows.is_empty() {
        rows.push(Row::new(vec![Cell::from(Span::styled(
            "(select a workflow to see its jobs)",
            Style::default().fg(theme::FG_MUTED),
        ))]));
    }
    let jobs = Table::new(
        rows,
        [
            Constraint::Percentage(34),
            Constraint::Percentage(30),
            Constraint::Min(20),
        ],
    )
    .header(
        Row::new(vec![
            Cell::from(Span::styled("Job", Style::default().fg(theme::FG_MUTED))),
            Cell::from(Span::styled(
                "Runs on",
                Style::default().fg(theme::FG_MUTED),
            )),
            Cell::from(Span::styled("Needs", Style::default().fg(theme::FG_MUTED))),
        ])
        .bottom_margin(1),
    )
    .block(content_block(&format!(
        "Jobs ({})",
        workflows.get(cursor).map_or(0, |w| w.jobs.len())
    )))
    .style(theme::base());
    frame.render_widget(jobs, panes[1]);
    frame.render_widget(
        Paragraph::new(
            "↑/↓/j/k = move   definitions from .github/workflows — run status lives on the git host",
        )
        .style(Style::default().fg(theme::FG_MUTED)),
        outer[1],
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
    let kv = |label: &str, value: String| {
        text::Line::from(vec![
            Span::styled(format!("{label:<16}"), Style::default().fg(theme::FG_MUTED)),
            Span::styled(value, Style::default().fg(theme::FG)),
        ])
    };
    let head = |title: &str| {
        text::Line::from(Span::styled(
            title.to_string(),
            Style::default().fg(theme::FG).add_modifier(Modifier::BOLD),
        ))
    };
    let mut lines = vec![
        head("Node"),
        kv("Status", snap.node_status.clone()),
        kv("Peer ID", snap.peer_id.clone()),
        kv("Connections", format!("{}", snap.connections.len())),
        text::Line::from(""),
        head("Kubo"),
        kv("Status", snap.kubo_status.clone()),
        kv("Endpoint", snap.kubo_endpoint.clone()),
        kv("Peer ID", snap.kubo_peer_id.clone()),
        text::Line::from(""),
        head("Git bridge"),
        kv(
            "Serve adverts",
            format!(
                "{}{}",
                snap.git_seen,
                if snap.serving { " (serving)" } else { "" }
            ),
        ),
        text::Line::from(""),
        head("Multiaddrs"),
    ];
    if snap.multiaddrs.is_empty() {
        lines.push(text::Line::from(Span::styled(
            "(none - browser node)",
            Style::default().fg(theme::FG_MUTED),
        )));
    } else {
        for addr in &snap.multiaddrs {
            lines.push(text::Line::from(Span::styled(
                addr.clone(),
                Style::default().fg(theme::FG),
            )));
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
    let mut rows: Vec<Row> = vec![];
    for conn in &snap.connections {
        let direction_color = if conn.direction == "inbound" {
            theme::SUCCESS
        } else {
            theme::ACCENT
        };
        rows.push(Row::new(vec![
            Cell::from(Span::styled(
                conn.peer.clone(),
                Style::default().fg(theme::FG),
            )),
            Cell::from(Span::styled(
                conn.direction.clone(),
                Style::default().fg(direction_color),
            )),
            Cell::from(Span::styled(
                conn.addr.clone(),
                Style::default().fg(theme::FG_MUTED),
            )),
        ]));
    }
    if rows.is_empty() {
        rows.push(Row::new(vec![Cell::from(Span::styled(
            "(no connections — press c to dial a multiaddr)",
            Style::default().fg(theme::FG_MUTED),
        ))]));
    }
    let peers = Table::new(
        rows,
        [
            Constraint::Percentage(34),
            Constraint::Length(10),
            Constraint::Min(20),
        ],
    )
    .header(
        Row::new(vec![
            Cell::from(Span::styled("Peer", Style::default().fg(theme::FG_MUTED))),
            Cell::from(Span::styled(
                "Direction",
                Style::default().fg(theme::FG_MUTED),
            )),
            Cell::from(Span::styled(
                "Address",
                Style::default().fg(theme::FG_MUTED),
            )),
        ])
        .bottom_margin(1),
    )
    .block(content_block(&format!(
        "Peers ({} connected)",
        snap.connections.len()
    )))
    .style(theme::base());
    frame.render_widget(peers, chunks[0]);
    let inbox = &app.ipfs.chat_inbox;
    let mut chat_lines = vec![];
    if inbox.is_empty() {
        chat_lines.push(text::Line::from("(no messages — press m to send one)"));
    } else {
        for msg in inbox.iter().rev() {
            // Oldest first so the newest sits at the bottom.
            let (mark, mark_color) = if msg.verified {
                ("✓", theme::SUCCESS)
            } else {
                ("✗", theme::DANGER)
            };
            chat_lines.push(text::Line::from(vec![
                Span::styled(format!("{mark} "), Style::default().fg(mark_color)),
                Span::styled(
                    format!("{} ", msg.timestamp),
                    Style::default().fg(theme::FG_MUTED),
                ),
                Span::styled(
                    format!("{}: ", msg.signer),
                    Style::default().fg(theme::ACCENT),
                ),
                Span::styled(msg.text.clone(), Style::default().fg(theme::FG)),
            ]));
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
