//! メニューバー。構成は要件定義書6章の「フェーズ4c のメニューバー全体の構成」（layout）。
//! Tauri の初期のメニューは文字が英語に固定されているため、作り直す。
//! 終了は保存を待つ項目に置き換えた。「編集」の取り消す・やり直す・すべてを選択と、キーを持つ画面の操作
//! （設定…、検索、詳細パネル、ゴミ箱へ移す）は、手前のウィンドウへ同じキーとして渡す（KEYS）

use tauri::menu::{
    AboutMetadata, CheckMenuItem, IsMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem,
    Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Runtime};

/// ライブラリ選択画面へ戻る項目（FR-105）。選ぶと main.rs が画面へ switch-library イベントを送る
pub const SWITCH_LIBRARY: &str = "switch-library";

/// アイデアボードの専用ウィンドウを開く項目（FR-701）。選ぶと main.rs が画面へ open-board イベントを送る
pub const OPEN_BOARD: &str = "open-board";

/// 選んだ画像をボードに追加する項目（FR-701）。選ぶと main.rs がギャラリーへ add-to-board イベントを送る
pub const ADD_TO_BOARD: &str = "add-to-board";

/// 選んだ1枚の「似た画像を探す」（FR-601、6章）。選ぶと main.rs がギャラリーへ find-similar イベントを送る
pub const FIND_SIMILAR: &str = "find-similar";

/// 元が同じ画像の組を探す項目（FR-611）。選ぶと main.rs がギャラリーへ find-origin-groups イベントを送る
pub const FIND_ORIGIN_GROUPS: &str = "find-origin-groups";

/// 選んだ1枚を Google 画像検索で探す（FR-612）。選ぶと main.rs がギャラリーへ search-google イベントを送る
pub const SEARCH_GOOGLE: &str = "search-google";

/// 隠すモードの切り替え（FR-513）。選ぶと main.rs が設定を書き換え、どのウィンドウにも hide-mode イベントで知らせる
pub const HIDE_MODE: &str = "hide-mode";

/// 「ヘルプ」の「Kura ヘルプ」（NFR-14）。選ぶと main.rs がヘルプのウィンドウを開く
pub const HELP: &str = "help";

/// 「編集」の取り消す・やり直す・すべてを選択（FR-702、NFR-12）。標準の項目は入力欄の文字にしか効かず、
/// ボードの配置やギャラリーの画像に届かないので置き換えた
pub const UNDO: &str = "undo";
pub const REDO: &str = "redo";
pub const SELECT_ALL: &str = "select-all";
/// キーを持つ画面の操作（6章）。押せる条件と動きをキーと同じにするため、キーとして渡す
pub const SETTINGS: &str = "settings";
pub const FIND: &str = "find";
pub const DETAIL: &str = "detail";
pub const TRASH: &str = "trash";
/// 選ぶと main.rs が手前のウィンドウへ edit-menu イベントで id を送り、画面が同じキーとして受ける
/// （src/editMenu.ts）。入力欄の文字の編集も画面が受け持つ
pub const KEYS: [&str; 7] = [UNDO, REDO, SELECT_ALL, SETTINGS, FIND, DETAIL, TRASH];

/// 終了の項目。既定の終了は AppKit の terminate: を直接呼び、保存待ちを通らないので置き換える
/// （spikes/board-native）。選ぶと main.rs がボードとメモの保存を待ってから終了する（FR-704、FR-411）
pub const QUIT: &str = "quit";

/// メニューの1項目。Item の enabled が false の項目は、ギャラリーの状態に合わせて windows.rs が有効にする
#[derive(Debug, PartialEq)]
pub enum Entry {
    Item {
        id: &'static str,
        label: String,
        key: Option<&'static str>,
        enabled: bool,
    },
    Check {
        id: &'static str,
        label: &'static str,
        key: &'static str,
        checked: bool,
    },
    /// macOS の標準の項目
    Std(Std, String),
    Sep,
}

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Std {
    About,
    Services,
    Hide,
    HideOthers,
    Cut,
    Copy,
    Paste,
    Fullscreen,
    Minimize,
    Maximize,
    CloseWindow,
}

pub struct Sub {
    /// macOS がウインドウとヘルプのメニューとみなす id
    pub id: Option<&'static str>,
    pub title: String,
    pub entries: Vec<Entry>,
}

fn item(id: &'static str, label: impl Into<String>, key: Option<&'static str>) -> Entry {
    Entry::Item {
        id,
        label: label.into(),
        key,
        enabled: true,
    }
}

/// ギャラリーの状態で押せるかが変わる項目。無効で始め、windows::update_gallery が有効にする
fn gated(id: &'static str, label: &str, key: Option<&'static str>) -> Entry {
    Entry::Item {
        id,
        label: label.into(),
        key,
        enabled: false,
    }
}

/// 要件定義書6章の構成。board が false（アイデアボードが OFF。FR-711）なら、ボードの項目とキーを入れない。
/// similarity が false（類似画像検索が OFF）なら、類似画像検索の項目と ⇧⌘F を入れない。
/// hide は隠すモードの間か（FR-513）。「隠すモード」に印を付ける
pub fn layout(name: &str, board: bool, similarity: bool, hide: bool) -> Vec<Sub> {
    use Entry::{Sep, Std as S};
    let sub = |id, title: &str, entries| Sub {
        id,
        title: title.into(),
        entries,
    };
    let mut file = vec![
        item(
            SWITCH_LIBRARY,
            "ライブラリを切り替える…",
            Some("CmdOrCtrl+Shift+O"),
        ),
        Sep,
    ];
    if board {
        file.push(gated(
            ADD_TO_BOARD,
            "ボードに追加…",
            Some("CmdOrCtrl+Shift+B"),
        ));
    }
    if similarity {
        file.push(gated(
            FIND_SIMILAR,
            "似た画像を探す",
            Some("CmdOrCtrl+Shift+F"),
        ));
        file.push(item(FIND_ORIGIN_GROUPS, "元が同じ画像の組を探す…", None));
    }
    file.extend([
        gated(SEARCH_GOOGLE, "Google 画像検索で探す", None),
        Sep,
        gated(TRASH, "ゴミ箱へ移す", Some("CmdOrCtrl+Backspace")),
        S(Std::CloseWindow, "ウインドウを閉じる".into()),
    ]);
    let mut window = vec![
        S(Std::Minimize, "しまう".into()),
        S(Std::Maximize, "拡大／縮小".into()),
        Sep,
    ];
    if board {
        window.extend([
            item(OPEN_BOARD, "アイデアボードを開く", Some("CmdOrCtrl+B")),
            Sep,
        ]);
    }
    window.push(S(Std::CloseWindow, "ウインドウを閉じる".into()));
    vec![
        sub(
            None,
            name,
            vec![
                S(Std::About, format!("{name} について")),
                Sep,
                gated(SETTINGS, "設定…", Some("CmdOrCtrl+,")),
                Sep,
                S(Std::Services, "サービス".into()),
                Sep,
                S(Std::Hide, format!("{name} を隠す")),
                S(Std::HideOthers, "ほかを隠す".into()),
                Sep,
                item(QUIT, format!("{name} を終了"), Some("CmdOrCtrl+Q")),
            ],
        ),
        sub(None, "ファイル", file),
        sub(
            None,
            "編集",
            vec![
                item(UNDO, "取り消す", Some("CmdOrCtrl+Z")),
                item(REDO, "やり直す", Some("CmdOrCtrl+Shift+Z")),
                Sep,
                S(Std::Cut, "カット".into()),
                S(Std::Copy, "コピー".into()),
                S(Std::Paste, "ペースト".into()),
                item(SELECT_ALL, "すべてを選択", Some("CmdOrCtrl+A")),
                Sep,
                gated(FIND, "検索", Some("CmdOrCtrl+F")),
            ],
        ),
        sub(
            None,
            "表示",
            vec![
                gated(DETAIL, "詳細パネルを隠す・出す", Some("CmdOrCtrl+I")),
                Entry::Check {
                    id: HIDE_MODE,
                    label: "隠すモード",
                    key: "CmdOrCtrl+Shift+H",
                    checked: hide,
                },
                Sep,
                S(Std::Fullscreen, "フルスクリーンにする".into()),
            ],
        ),
        // この id のメニューを macOS がウインドウのメニューとみなし、整列などの項目を足す
        sub(Some(WINDOW_SUBMENU_ID), "ウインドウ", window),
        // この id のメニューに macOS が項目の検索欄を足す
        sub(
            Some(HELP_SUBMENU_ID),
            "ヘルプ",
            vec![item(HELP, format!("{name} ヘルプ"), None)],
        ),
    ]
}

pub fn build<R: Runtime>(
    app: &AppHandle<R>,
    board: bool,
    similarity: bool,
    hide: bool,
) -> tauri::Result<Menu<R>> {
    let name = app.package_info().name.clone();
    let mut subs = vec![];
    for sub in layout(&name, board, similarity, hide) {
        let items = sub
            .entries
            .iter()
            .map(|e| kind(app, &name, e))
            .collect::<tauri::Result<Vec<_>>>()?;
        let refs: Vec<&dyn IsMenuItem<R>> = items.iter().map(|i| i as &dyn IsMenuItem<R>).collect();
        subs.push(match sub.id {
            Some(id) => Submenu::with_id_and_items(app, id, &sub.title, true, &refs)?,
            None => Submenu::with_items(app, &sub.title, true, &refs)?,
        });
    }
    let refs: Vec<&dyn IsMenuItem<R>> = subs.iter().map(|s| s as &dyn IsMenuItem<R>).collect();
    Menu::with_items(app, &refs)
}

fn kind<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
    entry: &Entry,
) -> tauri::Result<MenuItemKind<R>> {
    Ok(match entry {
        Entry::Item {
            id,
            label,
            key,
            enabled,
        } => MenuItemKind::MenuItem(MenuItem::with_id(app, *id, label, *enabled, *key)?),
        Entry::Check {
            id,
            label,
            key,
            checked,
        } => MenuItemKind::Check(CheckMenuItem::with_id(
            app,
            *id,
            label,
            false,
            *checked,
            Some(*key),
        )?),
        Entry::Sep => MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?),
        Entry::Std(s, label) => {
            let label = Some(label.as_str());
            MenuItemKind::Predefined(match s {
                Std::About => {
                    let about = AboutMetadata {
                        name: Some(name.into()),
                        version: Some(app.package_info().version.to_string()),
                        ..Default::default()
                    };
                    PredefinedMenuItem::about(app, label, Some(about))?
                }
                Std::Services => PredefinedMenuItem::services(app, label)?,
                Std::Hide => PredefinedMenuItem::hide(app, label)?,
                Std::HideOthers => PredefinedMenuItem::hide_others(app, label)?,
                Std::Cut => PredefinedMenuItem::cut(app, label)?,
                Std::Copy => PredefinedMenuItem::copy(app, label)?,
                Std::Paste => PredefinedMenuItem::paste(app, label)?,
                Std::Fullscreen => PredefinedMenuItem::fullscreen(app, label)?,
                Std::Minimize => PredefinedMenuItem::minimize(app, label)?,
                Std::Maximize => PredefinedMenuItem::maximize(app, label)?,
                Std::CloseWindow => PredefinedMenuItem::close_window(app, label)?,
            })
        }
    })
}

/// 項目 id を有効・無効にする。メニューにない（OFF で外した）ときは何もしない
pub fn enable<R: Runtime>(app: &AppHandle<R>, id: &str, enabled: bool) -> tauri::Result<()> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    for submenu in menu.items()? {
        let item = submenu.as_submenu().and_then(|s| s.get(id));
        if let Some(item) = item.as_ref().and_then(|i| i.as_menuitem()) {
            item.set_enabled(enabled)?;
        }
        if let Some(item) = item.as_ref().and_then(|i| i.as_check_menuitem()) {
            item.set_enabled(enabled)?;
        }
    }
    Ok(())
}

/// 印の付く項目 id の印を checked にそろえる。macOS は選んだときに印を自分で切り替えるので、保存した値に合わせ直す
pub fn check<R: Runtime>(app: &AppHandle<R>, id: &str, checked: bool) -> tauri::Result<()> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    for submenu in menu.items()? {
        let item = submenu.as_submenu().and_then(|s| s.get(id));
        if let Some(item) = item.as_ref().and_then(|i| i.as_check_menuitem()) {
            item.set_checked(checked)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 6章の表の書き方にする。「／」は区切りの線、（）はキー
    fn table(subs: &[Sub]) -> Vec<String> {
        subs.iter()
            .map(|s| {
                let mut row = format!("{}：", s.title);
                let mut first = true;
                for e in &s.entries {
                    let text = match e {
                        Entry::Sep => {
                            row.push('／');
                            first = true;
                            continue;
                        }
                        Entry::Item { label, key, .. } => match key {
                            Some(k) => format!("{label}（{}）", symbols(k)),
                            None => label.clone(),
                        },
                        Entry::Check { label, key, .. } => format!("{label}（{}）", symbols(key)),
                        Entry::Std(Std::Hide, label) => format!("{label}（⌘H）"),
                        Entry::Std(Std::CloseWindow, label) if s.title == "ファイル" => {
                            format!("{label}（⌘W）")
                        }
                        Entry::Std(_, label) => label.clone(),
                    };
                    if !first {
                        row.push('、');
                    }
                    row.push_str(&text);
                    first = false;
                }
                row
            })
            .collect()
    }

    fn symbols(key: &str) -> String {
        key.replace("CmdOrCtrl+", "⌘")
            .replace("Shift+", "⇧")
            .replace("Backspace", "Delete")
            .replace("⌘⇧", "⇧⌘")
    }

    #[test]
    fn すべて_on_なら6章の構成のとおりに並ぶ() {
        assert_eq!(
            table(&layout("Kura", true, true, false)),
            [
                "Kura：Kura について／設定…（⌘,）／サービス／Kura を隠す（⌘H）、ほかを隠す／Kura を終了（⌘Q）",
                "ファイル：ライブラリを切り替える…（⇧⌘O）／ボードに追加…（⇧⌘B）、似た画像を探す（⇧⌘F）、元が同じ画像の組を探す…、Google 画像検索で探す／ゴミ箱へ移す（⌘Delete）、ウインドウを閉じる（⌘W）",
                "編集：取り消す（⌘Z）、やり直す（⇧⌘Z）／カット、コピー、ペースト、すべてを選択（⌘A）／検索（⌘F）",
                "表示：詳細パネルを隠す・出す（⌘I）、隠すモード（⇧⌘H）／フルスクリーンにする",
                "ウインドウ：しまう、拡大／縮小／アイデアボードを開く（⌘B）／ウインドウを閉じる",
                "ヘルプ：Kura ヘルプ",
            ]
        );
    }

    #[test]
    fn アイデアボードと類似画像検索が_off_ならその項目を隠す() {
        let t = table(&layout("Kura", false, false, false));
        assert_eq!(
            t[1],
            "ファイル：ライブラリを切り替える…（⇧⌘O）／Google 画像検索で探す／ゴミ箱へ移す（⌘Delete）、ウインドウを閉じる（⌘W）"
        );
        assert_eq!(t[4], "ウインドウ：しまう、拡大／縮小／ウインドウを閉じる");
        let t = table(&layout("Kura", true, false, false));
        assert!(t[1].contains("ボードに追加…") && !t[1].contains("似た画像を探す"));
        let t = table(&layout("Kura", false, true, false));
        assert!(!t[1].contains("ボードに追加…") && t[1].contains("元が同じ画像の組を探す…"));
    }

    #[test]
    fn 隠すモードの間は印を付ける() {
        let checked = |hide| {
            layout("Kura", true, true, hide)
                .into_iter()
                .flat_map(|s| s.entries)
                .find_map(|e| match e {
                    Entry::Check { checked, .. } => Some(checked),
                    _ => None,
                })
        };
        assert_eq!(checked(true), Some(true));
        assert_eq!(checked(false), Some(false));
    }

    #[test]
    fn キーで渡す項目と状態で変わる項目は無効で始まる() {
        let gated: Vec<_> = layout("Kura", true, true, false)
            .into_iter()
            .flat_map(|s| s.entries)
            .filter_map(|e| match e {
                Entry::Item {
                    id, enabled: false, ..
                } => Some(id),
                _ => None,
            })
            .collect();
        assert_eq!(
            gated,
            [
                SETTINGS,
                ADD_TO_BOARD,
                FIND_SIMILAR,
                SEARCH_GOOGLE,
                TRASH,
                FIND,
                DETAIL
            ]
        );
    }
}
