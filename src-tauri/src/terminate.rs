//! Dock の「終了」やログアウトなど、AppKit の terminate: から始まる終了も、ボードとメモの保存を待つ
//! （FR-704、FR-411）。tao のアプリのデリゲートは applicationShouldTerminate: を持たず、AppKit はそのまま
//! 終了させる。Tauri の ExitRequested もこの経路では届かない（spikes/board-native）。
//! そこでデリゲートにこのメソッドを足して「後で答える」を返し、保存を待ってから答える

use std::sync::OnceLock;

use objc2::runtime::{AnyObject, Imp, Sel};
use objc2::{ffi, sel, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
use tauri::AppHandle;

static APP: OnceLock<AppHandle> = OnceLock::new();

unsafe extern "C-unwind" fn should_terminate(
    _this: *mut AnyObject,
    _cmd: Sel,
    _sender: *mut AnyObject,
) -> NSApplicationTerminateReply {
    let Some(app) = APP.get() else {
        return NSApplicationTerminateReply::TerminateNow;
    };
    log::info!("macOS から終了を求められました");
    crate::quit_then(app, |app, ok| {
        let reply = move || {
            let mtm = MainThreadMarker::new().expect("メインスレッドで答える");
            NSApplication::sharedApplication(mtm).replyToApplicationShouldTerminate(ok);
        };
        if let Err(e) = app.run_on_main_thread(reply) {
            log::error!("終了の問い合わせに答えられません：{e}");
        }
    });
    NSApplicationTerminateReply::TerminateLater
}

/// 起動時にメインスレッドで1度だけ呼ぶ
pub fn install(app: &AppHandle) {
    if APP.set(app.clone()).is_err() {
        return;
    }
    let Some(mtm) = MainThreadMarker::new() else {
        log::error!("終了の保存待ちを組み込めません：メインスレッドではありません");
        return;
    };
    let Some(delegate) = NSApplication::sharedApplication(mtm).delegate() else {
        log::error!("終了の保存待ちを組み込めません：アプリのデリゲートがありません");
        return;
    };
    let class = AsRef::<AnyObject>::as_ref(&*delegate).class();
    // SAFETY: 型の文字列 Q@:@ は should_terminate の引数（self、_cmd、sender）と戻り値（NSUInteger）に合う
    let added = unsafe {
        let imp: Imp = std::mem::transmute::<
            unsafe extern "C-unwind" fn(
                *mut AnyObject,
                Sel,
                *mut AnyObject,
            ) -> NSApplicationTerminateReply,
            Imp,
        >(should_terminate);
        ffi::class_addMethod(
            class as *const _ as *mut _,
            sel!(applicationShouldTerminate:),
            imp,
            c"Q@:@".as_ptr(),
        )
    };
    if !added.as_bool() {
        log::error!("終了の保存待ちを組み込めません：デリゲートに同じメソッドがあります");
    }
}
