//! GitHub Primer dark palette + shared style helpers for the TUI.
//!
//! The ratzilla app mirrors the web app's GitHub chrome (index.html), so
//! the terminal uses the same Primer dark colors GitHub renders by default
//! (https://primer.style/foundations/color). Everything visual imports from
//! here — no widget invents its own colors.

use ratzilla::ratatui::{
    style::{Color, Modifier, Style},
    text::Span,
};

// Surfaces
pub const CANVAS: Color = Color::Rgb(0x0d, 0x11, 0x17);
pub const CANVAS_INSET: Color = Color::Rgb(0x01, 0x04, 0x09);
pub const BTN_BG: Color = Color::Rgb(0x21, 0x26, 0x2d);

// Text
pub const FG: Color = Color::Rgb(0xe6, 0xed, 0xf3);
pub const FG_MUTED: Color = Color::Rgb(0x91, 0x98, 0xa1);
pub const FG_SUBTLE: Color = Color::Rgb(0x6e, 0x76, 0x81);
pub const ACCENT: Color = Color::Rgb(0x58, 0xa6, 0xff);

// Lines
pub const BORDER: Color = Color::Rgb(0x30, 0x36, 0x3d);
pub const BORDER_MUTED: Color = Color::Rgb(0x21, 0x26, 0x2d);
pub const BTN_BORDER: Color = Color::Rgb(0x3d, 0x44, 0x4d);

// States
pub const SUCCESS: Color = Color::Rgb(0x3f, 0xb9, 0x50);
pub const DANGER: Color = Color::Rgb(0xf8, 0x51, 0x49);
pub const ATTENTION: Color = Color::Rgb(0xd2, 0x99, 0x22);

// The one warm accent GitHub uses: the active repo-tab underline.
pub const TAB_UNDERLINE: Color = Color::Rgb(0xf7, 0x81, 0x66);

// Primary button (the green "Code ▾" on the repo page, Primer dark).
pub const PRIMARY: Color = Color::Rgb(0x23, 0x86, 0x36);
pub const ON_PRIMARY: Color = Color::Rgb(0xff, 0xff, 0xff);

/// Base application style: canvas background, default foreground.
pub fn base() -> Style {
    Style::default().bg(CANVAS).fg(FG)
}

/// Content block chrome — the muted borders GitHub wraps panels in.
pub fn block(title: &str) -> ratzilla::ratatui::widgets::Block<'static> {
    ratzilla::ratatui::widgets::Block::bordered()
        .title(Span::styled(
            format!(" {title} "),
            Style::default().fg(FG_MUTED),
        ))
        .border_style(Style::default().fg(BORDER))
        .style(base())
}

/// A GitHub button as spans: ` ☆ Star ` — inset background, muted text.
pub fn btn_spans(label: &str) -> Vec<Span<'static>> {
    vec![Span::styled(
        format!(" {label} "),
        Style::default().bg(BTN_BG).fg(FG_MUTED),
    )]
}

/// One repo-tabnav entry. `active` gets the bold foreground + the orange
/// underline that is GitHub's signature tab treatment.
pub fn tab(title: &str, active: bool) -> Span<'static> {
    if active {
        Span::styled(
            format!(" {title} "),
            Style::default()
                .fg(FG)
                .add_modifier(Modifier::BOLD)
                .add_modifier(Modifier::UNDERLINED),
        )
    } else {
        Span::styled(format!(" {title} "), Style::default().fg(FG_MUTED))
    }
}
