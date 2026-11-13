use std::fs;
use std::ops::RangeInclusive;
use std::path::Path;
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};

/// アプリ全体の設定。アプリのデータフォルダに置き、どのライブラリを開いても同じ値を使う。
/// ライブラリの中身に結び付く状態（カテゴリの開閉）は、ライブラリの DB に置く
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// サイドバーでカテゴリを移すときに確認する（FR-412）
    pub confirm_category_move: bool,
    /// 一覧の列の幅の目安（FR-501）。範囲に収めるのは画面側
    pub thumb_width: u32,
    /// サイドバーのタグ一覧を閉じている（FR-503）。タグが多いとサイドバーのスクロールが長くなるため
    pub tags_collapsed: bool,
    /// アイデアボードを使う（FR-711）。前の版の設定ファイルにはないので、更新した人も ON で始まる
    pub board_enabled: bool,
    /// ボードの専用ウィンドウの表示（FR-705、FR-707）。board_enabled を切っても消さない（FR-711）
    pub board_window: BoardWindow,
}

/// 不透明度（%）の範囲（FR-707）
pub const OPACITY: RangeInclusive<u8> = 30..=100;

/// アイデアボードの専用ウィンドウの表示。ボードやライブラリごとではなく、アプリ全体で1つ持つ
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BoardWindow {
    /// 最前面に固定する（FR-705）
    pub always_on_top: bool,
    /// 不透明度（%）。OPACITY の範囲（FR-707）
    pub opacity: u8,
    /// タイトルバーを含むウィンドウの枠。まだ開いたことがなければ None
    pub frame: Option<Rect>,
}

impl Default for BoardWindow {
    fn default() -> Self {
        BoardWindow {
            always_on_top: false,
            opacity: *OPACITY.end(),
            frame: None,
        }
    }
}

impl BoardWindow {
    /// NSWindow に渡す値。手で書き換えたファイルの範囲外の値は、範囲の端に寄せる
    pub fn alpha(&self) -> f64 {
        f64::from(self.opacity.clamp(*OPACITY.start(), *OPACITY.end())) / 100.0
    }
}

/// 画面の上の四角。単位は macOS の点（Retina でも変わらない長さ）で、原点は主ディスプレイの左上
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    fn overlap(&self, other: &Rect) -> f64 {
        let side = |a: f64, al: f64, b: f64, bl: f64| ((a + al).min(b + bl) - a.max(b)).max(0.0);
        side(self.x, self.width, other.x, other.width)
            * side(self.y, self.height, other.y, other.height)
    }
}

/// ボードのウィンドウを開く枠を決める（FR-705）。screens は今つながっている画面の、Dock とメニューバーを
/// 除いた範囲で、先頭がメイン画面のあるディスプレイ。画面が1つも分からなければ None。
/// saved がなければ先頭の画面の中央に size で開く。あれば、いちばん広く重なる画面（どれとも重ならなければ
/// 先頭の画面）の中に収まるよう、大きさを縮めてから位置をずらす。外したモニターにあった枠はここで戻る
pub fn place(saved: Option<Rect>, size: (f64, f64), screens: &[Rect]) -> Option<Rect> {
    let home = screens.first()?;
    let (frame, screen) = match saved {
        Some(frame) => {
            let widest = screens.iter().fold(home, |best, s| {
                if s.overlap(&frame) > best.overlap(&frame) {
                    s
                } else {
                    best
                }
            });
            (frame, widest)
        }
        None => {
            let centered = Rect {
                x: home.x + (home.width - size.0) / 2.0,
                y: home.y + (home.height - size.1) / 2.0,
                width: size.0,
                height: size.1,
            };
            (centered, home)
        }
    };
    let width = frame.width.min(screen.width);
    let height = frame.height.min(screen.height);
    Some(Rect {
        x: frame.x.clamp(screen.x, screen.x + screen.width - width),
        y: frame.y.clamp(screen.y, screen.y + screen.height - height),
        width,
        height,
    })
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            confirm_category_move: true,
            thumb_width: 200,
            tags_collapsed: false,
            board_enabled: true,
            board_window: BoardWindow::default(),
        }
    }
}

/// 設定を読んで書き直す間、ほかの書き直しを待たせる。ギャラリーの設定とボードのウィンドウの表示は
/// 別のウィンドウから同じファイルを書くので、片方がもう片方の変更を古い値で上書きしないようにする
static WRITING: Mutex<()> = Mutex::new(());

/// ファイルがないか壊れていれば初期値を返す。足りない項目も初期値で埋める（後の版で項目を足したとき）
pub fn load(file: &Path) -> Settings {
    fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn save(file: &Path, settings: &Settings) -> std::io::Result<()> {
    write_json(file, settings)
}

/// 保存してから apply(前の設定, 新しい設定) で画面以外への反映（メニューなど）を行う。
/// 反映に失敗したらファイルを前の設定に戻す。画面は失敗を受けて前の値に戻るので、ファイルもそろえる
pub fn save_and_apply(
    file: &Path,
    settings: &Settings,
    apply: impl FnOnce(&Settings, &Settings) -> Result<(), String>,
) -> Result<(), String> {
    let _writing = WRITING.lock().unwrap_or_else(PoisonError::into_inner);
    let before = load(file);
    // ギャラリーの画面は、開いたときに読んだ設定をまるごと送ってくる。ボードのウィンドウの表示は
    // ボードの側が後から変えているので、送られてきた古い値ではなくファイルの値を残す
    let settings = &Settings {
        board_window: before.board_window,
        ..settings.clone()
    };
    save(file, settings).map_err(|e| format!("設定を保存できません（{e}）"))?;
    apply(&before, settings).inspect_err(|_| {
        if let Err(e) = save(file, &before) {
            log::error!("設定を前の値に戻せません：{e}");
        }
    })
}

/// 今の設定の一部だけを change で変えて保存する。変わらなければ書かない
pub fn update(file: &Path, change: impl FnOnce(&mut Settings)) -> std::io::Result<()> {
    let _writing = WRITING.lock().unwrap_or_else(PoisonError::into_inner);
    let before = load(file);
    let mut after = before.clone();
    change(&mut after);
    if after == before {
        return Ok(());
    }
    save(file, &after)
}

/// 書き込みの途中で止まっても前の内容が壊れないよう、別名に書いてから置き換える
pub fn write_json(file: &Path, value: &impl Serialize) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec(value)?)?;
    fs::rename(&tmp, file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::category::tests::{lock, unlock};

    #[test]
    fn ファイルがなければ初期値() {
        let dir = tempfile::tempdir().unwrap();

        let s = load(&dir.path().join("settings.json"));

        assert_eq!(s, Settings::default());
        assert!(s.confirm_category_move);
        assert_eq!(s.thumb_width, 200);
        assert!(s.board_enabled);
    }

    #[test]
    fn 保存した値を読める() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("app/settings.json");
        let s = Settings {
            confirm_category_move: false,
            thumb_width: 140,
            tags_collapsed: true,
            board_enabled: false,
            board_window: BoardWindow {
                always_on_top: true,
                opacity: 45,
                frame: Some(Rect {
                    x: -1200.0,
                    y: 80.5,
                    width: 600.0,
                    height: 500.0,
                }),
            },
        };

        save(&file, &s).unwrap();

        assert_eq!(load(&file), s);
    }

    #[test]
    fn 足りない項目は初期値で埋める() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        fs::write(&file, r#"{"thumb_width": 300, "unknown": 1}"#).unwrap();

        let s = load(&file);

        assert_eq!(s.thumb_width, 300);
        assert!(s.confirm_category_move);
        // タグ一覧の開閉は後の版で足したので、前の版のファイルには項目がない。開いた状態で始める
        assert!(!s.tags_collapsed);
        // アイデアボードもフェーズ2で足した。前の版から更新した人も ON で始める
        assert!(s.board_enabled);
        // ボードのウィンドウの表示もフェーズ2で足した。最前面は OFF、不透明度は100%、枠はなしで始める
        assert!(!s.board_window.always_on_top);
        assert_eq!(s.board_window.opacity, 100);
        assert_eq!(s.board_window.frame, None);
    }

    #[test]
    fn アイデアボードを切った選択は保存して読み直しても残る() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        let s = Settings {
            board_enabled: false,
            ..Settings::default()
        };

        save(&file, &s).unwrap();

        assert!(!load(&file).board_enabled);
    }

    #[test]
    fn 保存の後の反映に失敗したらファイルを前の設定に戻す() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        save(&file, &Settings::default()).unwrap();
        let off = Settings {
            board_enabled: false,
            ..Settings::default()
        };

        let r = save_and_apply(&file, &off, |before, after| {
            assert!(before.board_enabled && !after.board_enabled);
            Err("メニューを変えられません".into())
        });

        assert_eq!(r, Err("メニューを変えられません".into()));
        assert!(load(&file).board_enabled);
    }

    #[test]
    fn 反映できたら保存した設定が残る() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        let off = Settings {
            board_enabled: false,
            ..Settings::default()
        };

        save_and_apply(&file, &off, |_, _| Ok(())).unwrap();

        assert!(!load(&file).board_enabled);
    }

    #[test]
    fn 壊れたファイルは初期値として扱い次の保存で直す() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        fs::write(&file, "{壊れた").unwrap();

        assert_eq!(load(&file), Settings::default());
        save(&file, &Settings::default()).unwrap();
        assert_eq!(load(&file), Settings::default());
    }

    #[test]
    fn 保存に失敗しても前の値が残る() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        let before = Settings {
            confirm_category_move: false,
            thumb_width: 120,
            tags_collapsed: false,
            board_enabled: true,
            board_window: BoardWindow::default(),
        };
        save(&file, &before).unwrap();
        if !lock(dir.path()) {
            return;
        }

        let r = save(&file, &Settings::default());
        unlock(dir.path());

        assert!(r.is_err());
        assert_eq!(load(&file), before);
    }

    const MAIN: Rect = Rect {
        x: 0.0,
        y: 25.0,
        width: 1440.0,
        height: 875.0,
    };
    // 主ディスプレイの左に置いた外付け
    const LEFT: Rect = Rect {
        x: -1920.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    };

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn on_top(file: &Path) -> BoardWindow {
        let window = BoardWindow {
            always_on_top: true,
            opacity: 30,
            frame: Some(rect(10.0, 40.0, 600.0, 500.0)),
        };
        update(file, |s| s.board_window = window).unwrap();
        window
    }

    #[test]
    fn 一部だけを変えるとほかの項目は残る() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        let off = Settings {
            board_enabled: false,
            thumb_width: 140,
            ..Settings::default()
        };
        save(&file, &off).unwrap();

        let window = on_top(&file);

        assert_eq!(
            load(&file),
            Settings {
                board_window: window,
                ..off
            }
        );
    }

    #[test]
    fn ギャラリーが古い設定を保存してもボードのウィンドウの表示は残る() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        // ギャラリーは、ボードが表示を変える前の設定を持ったまま
        let stale = Settings::default();
        let window = on_top(&file);

        // アイデアボードを OFF にしても消さない（FR-711）
        let off = Settings {
            board_enabled: false,
            ..stale
        };
        save_and_apply(&file, &off, |_, _| Ok(())).unwrap();

        let s = load(&file);
        assert!(!s.board_enabled);
        assert_eq!(s.board_window, window);
    }

    #[test]
    fn 変わらなければファイルを書かない() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");

        update(&file, |s| s.board_window.opacity = 100).unwrap();

        assert!(!file.exists());
    }

    #[test]
    fn 一部の保存に失敗しても前の値が残る() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        let before = on_top(&file);
        if !lock(dir.path()) {
            return;
        }

        let r = update(&file, |s| s.board_window.opacity = 80);
        unlock(dir.path());

        assert!(r.is_err());
        assert_eq!(load(&file).board_window, before);
    }

    #[test]
    fn 範囲の外の不透明度は範囲の端として扱う() {
        let alpha = |opacity| {
            BoardWindow {
                opacity,
                ..BoardWindow::default()
            }
            .alpha()
        };

        assert_eq!(alpha(0), 0.3);
        assert_eq!(alpha(30), 0.3);
        assert_eq!(alpha(65), 0.65);
        assert_eq!(alpha(100), 1.0);
        assert_eq!(alpha(255), 1.0);
    }

    #[test]
    fn 初回はメイン画面のあるディスプレイの中央に開く() {
        // 先頭がメイン画面のあるディスプレイ。主ディスプレイとは限らない
        let placed = place(None, (960.0, 668.0), &[LEFT, MAIN]);

        assert_eq!(placed, Some(rect(-1440.0, 206.0, 960.0, 668.0)));
    }

    #[test]
    fn 画面の中にある枠は動かさない() {
        let saved = rect(-1800.0, 100.0, 600.0, 500.0);

        assert_eq!(
            place(Some(saved), (960.0, 668.0), &[MAIN, LEFT]),
            Some(saved)
        );
    }

    #[test]
    fn 外したモニターにあった枠は残った画面の中に戻す() {
        let saved = rect(-1800.0, 100.0, 600.0, 500.0);

        let placed = place(Some(saved), (960.0, 668.0), &[MAIN]);

        assert_eq!(placed, Some(rect(0.0, 100.0, 600.0, 500.0)));
    }

    #[test]
    fn 画面からはみ出した枠はいちばん広く重なる画面の中に寄せる() {
        // 大半が外付けにあり、右端だけ主ディスプレイにかかる。下は外付けの画面からはみ出す
        let saved = rect(-500.0, 800.0, 600.0, 500.0);

        let placed = place(Some(saved), (960.0, 668.0), &[MAIN, LEFT]);

        assert_eq!(placed, Some(rect(-600.0, 580.0, 600.0, 500.0)));
    }

    #[test]
    fn 画面より大きい枠は画面の大きさに縮める() {
        let saved = rect(-100.0, 0.0, 2560.0, 1400.0);

        assert_eq!(place(Some(saved), (960.0, 668.0), &[MAIN]), Some(MAIN));
    }

    #[test]
    fn 画面が分からなければ枠を決めない() {
        assert_eq!(place(None, (960.0, 668.0), &[]), None);
    }
}
