#!/usr/bin/env bash
# Generates real book fixtures for manual checks and browser E2E:
# a minimal EPUB 3, an FB2, a Markdown file, a TXT, a hand-written PDF,
# and the PDF.js support assets (cmaps/standard fonts) for the app shell.
# No network needed; uses /usr/bin/zip.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/apps/desktop/public/fixtures"
PUBLIC_PDFJS="$ROOT/apps/desktop/public/pdfjs"
PDFJS_DIST="$ROOT/packages/reader-adapter/node_modules/pdfjs-dist"

rm -rf "$OUT"
mkdir -p "$OUT/epub-src/META-INF" "$OUT/epub-src/OEBPS" "$PUBLIC_PDFJS"

# --- EPUB 3 (two chapters, Chinese content) ---------------------------------
cat > "$OUT/epub-src/mimetype" <<'EOF'
application/epub+zip
EOF
cat > "$OUT/epub-src/META-INF/container.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
EOF
cat > "$OUT/epub-src/OEBPS/content.opf" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:5e5f6a2a-9c1a-4a3f-9d3a-000000000001</dc:identifier>
    <dc:title>夜航书</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:language>zh</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>
EOF
cat > "$OUT/epub-src/OEBPS/nav.xhtml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>目录</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
      <li><a href="ch1.xhtml">第一章 启程</a></li>
      <li><a href="ch2.xhtml">第二章 夜谈</a></li>
    </ol>
  </nav>
</body>
</html>
EOF
cat > "$OUT/epub-src/OEBPS/ch1.xhtml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="utf-8"/><title>第一章 启程</title></head>
<body>
  <h1>第一章 启程</h1>
  <p>灯塔在黎明前熄灭了,守塔人把最后一卷书放进行囊。海风翻动纸页,像在替他读出声来。</p>
  <p>他说:凡是读完就忘的书,本来就不该读完。于是他把这句话也写进了书里。</p>
</body>
</html>
EOF
cat > "$OUT/epub-src/OEBPS/ch2.xhtml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="utf-8"/><title>第二章 夜谈</title></head>
<body>
  <h1>第二章 夜谈</h1>
  <p>夜里没有风。两个人对坐,中间隔着一盏灯,灯芯偶尔响一声,像替他们承认了什么。</p>
  <p>他们谈到了远处的城市,谈到了那里的电灯,以及电灯下面,再也看不见星星的人。</p>
</body>
</html>
EOF
cd "$OUT/epub-src"
rm -f "$OUT/夜航书.epub"
zip -X0 "$OUT/夜航书.epub" mimetype > /dev/null
zip -rX9 "$OUT/夜航书.epub" META-INF OEBPS > /dev/null
cd "$ROOT"

# --- FB2 --------------------------------------------------------------------
cat > "$OUT/山中手记.fb2" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description>
    <title-info>
      <book-title>山中手记</book-title>
      <author><first-name>山</first-name><last-name>客</last-name></author>
      <lang>zh</lang>
    </title-info>
  </description>
  <body>
    <title><p>第一日 进山</p></title>
    <p>进山的第一日,雾把所有的路都收走了,只留下脚下这一条。</p>
    <title><p>第二日 听泉</p></title>
    <p>泉水在夜里比白天响。山里人说,那是因为夜晚的耳朵更诚实。</p>
  </body>
</FictionBook>
EOF

# --- TXT --------------------------------------------------------------------
{
  echo "化雪的季节"
  echo ""
  echo "第一章 灯"
  echo ""
  echo "化雪的时候,镇上的人把屋檐下的灯全都点了起来。雪水顺着瓦当滴落,敲在青石板上,像一封很长很长的信,被慢慢读完。"
  echo ""
  echo '“孩子们数着滴水,数到一百就天黑了。”守灯人说。'
  echo ""
  echo "第二章 信"
  echo ""
  echo "老人说,雪化完的那天,信就到了。"
  echo ""
  echo "没有人知道收信人是谁。但每年这个时候,镇上的人都会把灯点上,把路照得亮一些。"
} > "$OUT/化雪的季节.txt"

# --- Markdown ---------------------------------------------------------------
cat > "$OUT/阅读笔记.md" <<'EOF'
# 阅读笔记

## 为什么读书

读书是把别人的 lifetime 借来,在自己的下午里过一遍。

- 慢一点,再慢一点
- 在页边写下不同意的地方
- 合上书,回忆一遍

> 阅读是唯一一种,连孤独都显得慷慨的活动。

## 下一步

明天继续读第三章。
EOF

# --- PDF (hand-written, one page) -------------------------------------------
cat > "$OUT/demo.pdf" <<'EOF'
%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R
   /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 96 >>
stream
BT /F1 28 Tf 72 700 Td (Hello, AI Reader.) Tj ET
BT /F1 14 Tf 72 660 Td (A one-page PDF fixture.) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
0
%%EOF
EOF

# --- PDF with an embedded image (night-mode "keep images" checks) -----------
node "$ROOT/scripts/make-image-pdf.mjs"

# --- MOBI (generated minimal but real PalmDB/PalmDOC/MOBI binary) -----------
node "$ROOT/scripts/make-mobi.mjs"

# --- PDF.js support assets (CJK cmaps + standard fonts) ---------------------
if [ -d "$PDFJS_DIST" ]; then
  rm -rf "$PUBLIC_PDFJS/cmaps" "$PUBLIC_PDFJS/standard_fonts"
  cp -R "$PDFJS_DIST/cmaps" "$PUBLIC_PDFJS/cmaps"
  cp -R "$PDFJS_DIST/standard_fonts" "$PUBLIC_PDFJS/standard_fonts"
  echo "pdfjs assets copied to $PUBLIC_PDFJS"
fi

echo "fixtures written to $OUT"
ls -la "$OUT"
