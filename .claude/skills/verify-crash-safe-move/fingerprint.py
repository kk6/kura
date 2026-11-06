"""Rust の関数1つの本体の指紋（空白を詰めた sha256 の先頭16桁）を出す。check.sh から使う。

使い方：python3 -I fingerprint.py <file.rs> <関数名>    （関数がなければ MISSING）
       python3 -I fingerprint.py --self-test

関数の終わりは、コメント・文字列・文字リテラルの中の波括弧を数えずに探す。
中の波括弧を数えると、`// }` のようなコメントで範囲が早く終わり、その後の変更を見逃すため。
"""

import hashlib
import re
import sys

RAW = re.compile(r'b?r(#*)"')
CHAR = re.compile(r"'(\\(x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^\\'\n])'")


def body_end(src: str, start: int) -> int:
    """src[start] は関数の最初の {。対応する } の位置を返す"""
    depth, j, n = 0, start, len(src)
    while j < n:
        ident_before = j > 0 and (src[j - 1].isalnum() or src[j - 1] == "_")
        if src.startswith("//", j):
            j = src.find("\n", j)
            j = n if j < 0 else j
            continue
        if src.startswith("/*", j):  # Rust のブロックコメントは入れ子にできる
            level, j = 1, j + 2
            while j < n and level:
                if src.startswith("/*", j):
                    level, j = level + 1, j + 2
                elif src.startswith("*/", j):
                    level, j = level - 1, j + 2
                else:
                    j += 1
            continue
        m = None if ident_before else RAW.match(src, j)
        if m:
            close = '"' + m.group(1)
            j = src.find(close, m.end())
            j = n if j < 0 else j + len(close)
            continue
        c = src[j]
        if c == '"':
            j += 1
            while j < n and src[j] != '"':
                j += 2 if src[j] == "\\" else 1
            j += 1
            continue
        if c == "'":
            m = CHAR.match(src, j)
            j = m.end() if m else j + 1  # 合わなければライフタイム（'a）
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return j
        j += 1
    return n - 1


def fingerprint(src: str, name: str) -> str:
    m = re.search(
        r"^\s*(pub(\([a-z]+\))?\s+)?fn\s+" + re.escape(name) + r"\b", src, re.MULTILINE
    )
    if not m:
        return "MISSING"
    end = body_end(src, src.index("{", m.end()))
    body = re.sub(r"\s+", " ", src[m.start() : end + 1])
    return hashlib.sha256(body.encode()).hexdigest()[:16]


def self_test() -> None:
    base = """fn f(a: &'a str) {
    // }
    let s = "}"; let r = r#"}"#; let c = '}'; let b = b'{';
    /* } /* { */ } */
    if a.is_empty() { step_one(); }
    step_two();
}
fn g() {}
"""
    fp = fingerprint(base, "f")
    # コメントや文字列の } の後の変更も、指紋を変える
    assert fingerprint(base.replace("step_two", "step_three"), "f") != fp
    assert fingerprint(base.replace("step_one", "step_zero"), "f") != fp
    # 関数の外の変更は、指紋を変えない
    assert fingerprint(base.replace("fn g() {}", "fn g() { x(); }"), "f") == fp
    # 空白だけの変更は、指紋を変えない
    assert fingerprint(base.replace("    step_two();", "\t\tstep_two();"), "f") == fp
    assert fingerprint(base, "missing") == "MISSING"
    print("ok     fingerprint.py self-test")


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
    else:
        with open(sys.argv[1], encoding="utf-8") as f:
            print(fingerprint(f.read(), sys.argv[2]))
