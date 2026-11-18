use ratzilla::ratatui::{
    layout::{Constraint, Layout},
    prelude::Color,
    style::Style,
};
use tachyonfx::{
    fx::*, CellFilter, ColorSpace, Duration, Effect, EffectTimer, Interpolation::*, Motion,
};

use crate::theme;

pub fn startup() -> Effect {
    let timer = EffectTimer::from_ms(3000, QuadIn);

    parallel(&[
        parallel(&[
            sweep_in(Motion::LeftToRight, 100, 20, theme::CANVAS, timer),
            sweep_in(Motion::UpToDown, 100, 20, theme::CANVAS, timer),
        ]),
        prolong_start(500, coalesce((2500, SineOut))),
    ])
}

pub(super) fn change_tab() -> Effect {
    // Content area = everything below the 4-row GitHub chrome.
    let layout = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(2),
        Constraint::Min(0),
    ]);
    let dissolved = Style::default().fg(theme::FG).bg(theme::CANVAS);

    let flash_color = Color::from_u32(0x161b22);

    sequence(&[
        // close panel effect
        with_duration(
            Duration::from_millis(300),
            parallel(&[
                style_all_cells(),
                never_complete(fade_to(flash_color, flash_color, (30, ExpoInOut))),
                never_complete(dissolve_to(dissolved, (125, ExpoInOut))),
                never_complete(fade_to_fg(BG_COLOR, (125, BounceOut))),
            ])
            .with_color_space(ColorSpace::Rgb),
        ),
        // init pane, after having closed the (not) "old" one
        parallel(&[
            style_all_cells(),
            fade_from(BG_COLOR, BG_COLOR, (140, Linear)),
            sweep_in(Motion::UpToDown, 40, 0, BG_COLOR, (140, Linear))
                .with_color_space(ColorSpace::Hsl),
        ]),
    ])
    .with_filter(CellFilter::Layout(layout, 3))
}

/// Style all cells have so that they have non-reset foreground and background colors.
/// This ensures that color interpolation works correctly.
fn style_all_cells() -> Effect {
    never_complete(effect_fn((), 100_000, |_, _, cells| {
        for (_, cell) in cells {
            if cell.fg == Color::Reset {
                cell.set_fg(theme::FG);
            }

            if cell.bg == Color::Reset {
                cell.set_bg(theme::CANVAS);
            }
        }
    }))
}

const BG_COLOR: Color = theme::CANVAS;
