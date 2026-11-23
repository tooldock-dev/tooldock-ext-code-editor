# 💻 程式碼編輯器

ToolDock 擴充：像記事本一樣輕巧的程式碼編輯器。建立專案、瀏覽資料夾、語法高亮編輯、跳到定義、跨檔案搜尋與取代、反編譯 .class，並查看 Git 異動與差異比對、還原變更、瀏覽檔案歷史。

ToolDock 1.4.0 以上可以從擴充商店安裝。ToolDock 1.8.x 曾經內建這個擴充，1.9.0 起改由商店提供；從 1.8.x 升級的使用者安裝後，原本的專案與設定都還在。

## 功能

- **專案**：選一個資料夾建立專案，用下拉選單切換；可以重新命名或從清單移除（不會刪除資料夾）。每個專案會記住上次開著的檔案與展開的資料夾。
- **檔案樹**：
  - 瀏覽專案底下的每一層資料夾，資料夾展開時才讀取。
  - `⌘P`（Windows 為 `Ctrl+P`）以檔名搜尋整個專案，方向鍵選擇、Enter 開啟。
  - 右鍵可以新增檔案或資料夾、重新命名、複製路徑或相對路徑、在 Finder／檔案總管中顯示。
  - 設定 `codeEditor.exclude` 可以排除不想看到的檔案，預設排除 `node_modules`、`.git` 等。
- **語法高亮**：使用 [highlight.js](https://highlightjs.org/)，支援 50 多種語言，依副檔名自動判斷，也可以在狀態列切換。語言模組依需要載入。
- **編輯**：
  - 多分頁。單擊檔案以「預覽分頁」開啟（斜體），點下一個檔案時會被取代，方便一路瀏覽；開始編輯或雙擊就會固定。
  - 行號、目前行標示；Enter 延續縮排、Tab／Shift+Tab 整段縮排、`⌘/` 切換行註解。
  - `⌘F` 尋找、`⌥⌘F`（Windows 為 `Ctrl+H`）取代（可區分大小寫、使用規則運算式）、`⌃G` 前往行（可輸入「行:欄」）。
  - 狀態列可以切換自動換行、縮排方式（空格／Tab）與換行字元（LF／CRLF）。
  - 存檔時保留原本的換行字元與 BOM。
  - 檔案在外部被修改時自動重新載入；這裡也有未儲存的修改時，會先詢問。
- **鍵盤快捷鍵**（`⌘K`，Windows 為 `Ctrl+K`；也可以從專案選單「⋯」或狀態列的 ⌨ 開啟）：
  - 列出所有功能目前的快捷鍵，可以用功能名稱搜尋，或按「以按鍵查詢」直接按下組合鍵，看它被哪個功能使用。
  - 點 ✎（或雙擊一列）後按下新的組合鍵就會換掉；＋ 再加一組；✕ 移除；↺ 還原這個功能的預設；「全部還原預設」一次還原。修改立即生效並自動儲存。
  - 組合鍵已經被別的功能使用時，會詢問是否改用（原本的功能會移除這組按鍵）。
  - ToolDock 選單使用的按鍵（例如 `⌘W` 關閉分頁、`⇧⌘S` 擴充商店、`⌘H` 隱藏 ToolDock）按下時會先被選單處理，不能指定；單獨的字母鍵會影響打字，也不能指定（F1–F12 可以）。
  - Tab、Enter、Esc、`⌘` 點擊等編輯器內建的按鍵固定不能修改，面板最後有列表。
- **跳到定義**：
  - 按住 `⌘`（Windows 為 `Ctrl`）點方法、函式、類別或屬性的名稱，或把游標放在名稱上按 `F12`，會開啟定義所在的檔案並選取名稱；`⇧F12` 在專案中搜尋這個名稱的所有參考。
  - `⌃-`（Windows 為 `Alt+←`）回到跳轉前的位置，`⌃⇧-`（`Alt+→`）再往前。
  - 不分析型別，而是依各語言的定義寫法（`function`、`class`、`def`、方法簽章、`CREATE PROCEDURE`…）建立專案的符號索引。同名的定義有好幾個時會列出清單（↑↓ 選擇、Enter 開啟），依序是：`import`／`require` 指到的檔案、同一個檔案、同語言同資料夾、同語言、其他語言；能從 `import` 確定來源時直接跳過去。
  - 支援 JavaScript／TypeScript、Java、Kotlin、Scala、Groovy、C#、C／C++／Objective-C、Python、Go、Rust、PHP、Ruby、Swift、Dart、Lua、Perl、PowerShell、VB、Shell，以及 SQL／PL-SQL（不分大小寫）。
  - 第一次使用時建立索引，存在擴充的資料夾裡；重新啟動 ToolDock 後只要檢查一次哪些檔案改過，不用重新解析整個專案。之後在 macOS 與 Windows 監看專案資料夾，只處理有變動的檔案（其他平台每次查詢時檢查修改時間）。尚未儲存的分頁以編輯器中的內容為準。找不到定義，或游標就在定義上時，改為尋找所有參考。
  - 和跨檔案搜尋一樣不看「搜尋排除」設定與 `.gitignore` 忽略的檔案。
- **反編譯 .class**：
  - 在檔案樹開啟 `.class` 檔，會以附帶的 [CFR](https://www.benf.org/other/cfr/) 反編譯成 Java 原始碼，在唯讀分頁中語法高亮顯示；同一個資料夾中的內部類別（`Outer$Inner.class`）會一起還原。可以「另存新檔」存成 `.java`。
  - 需要 Java 執行環境（8 以上）：依序使用設定 `codeEditor.javaPath`、`JAVA_HOME`、macOS 的 `/usr/libexec/java_home`、`PATH` 上的 `java`。找不到 Java 時改為只顯示類別結構（類別、欄位、方法的宣告，不含方法內容）。
  - 請只反編譯你有權使用的程式。
- **跨檔案搜尋與取代**（側欄「搜尋」分頁，`⌘⇧F` 搜尋、`⌘⇧H` 取代）：
  - 可區分大小寫、整個字相符、使用規則運算式；「檔案篩選」可以指定要包含或排除的檔案（`*.js, src/`、`test, *.min.js`，支援 `*`、`**`、`{a,b}`）。檔案樹的排除設定也會套用。
  - 大型專案只搜尋原始碼：略過設定 `codeEditor.searchExclude` 列出的資料夾（預設有 `Pods`、`DerivedData`、`.expo`、`.next`、`.gradle`、`venv`、`*.min.js` 等），以及 git 專案中被 `.gitignore`（含巢狀的 `.gitignore` 與 `.git/info/exclude`）忽略的檔案，這些資料夾整個不會走進去。檔案樹照常顯示它們。「檔案篩選」裡取消勾選「套用搜尋排除設定與 .gitignore」就會連這些檔案一起搜尋。
  - 結果依檔案分組列出每一處的行號與前後文；點一下開啟並選取那一處，方向鍵可以一路瀏覽。檔案樹的資料夾右鍵有「在這個資料夾中搜尋…」。
  - 展開取代後，清單會顯示取代前後的對照（刪除線／新增），**先檢查再取代**：可以逐一取代、取代一個檔案，或勾選後「取代所選」；不想取代的項目取消勾選或從清單移除。
  - 規則運算式的取代字串可以用 `$1`、`$<名稱>`、`$&`，以及 `\n`、`\t`。
  - 取代前會確認每一處的原文還和搜尋時一樣，檔案在搜尋之後被改過就不取代，並列出沒有完成的檔案。
  - 沒有在編輯器中修改過的檔案直接寫入硬碟（保留換行字元與 BOM），可以按「復原上次取代」還原；已開啟且尚未儲存的檔案改在編輯器中取代，用 `⌘Z` 復原。
- **Git 異動清單**：
  - 「變更」分頁顯示目前分支、領先／落後的提交數與最近一次提交。
  - 異動分成合併衝突、已暫存、變更、未追蹤四組；檔案樹也會標示有異動的檔案與資料夾。
  - 專案是儲存庫的子資料夾時，只列出這個資料夾內的異動。
- **Git 還原**：
  - 「變更」中的檔案：滑過時的 `↶`、右鍵或比對畫面的「還原檔案…」會捨棄工作目錄的修改，改回暫存區的版本（沒有 `git add` 過就是最近一次提交的版本）；被刪除的檔案會重新建立。群組標題的 `↶` 可以一次還原全部。
  - 「未追蹤」的檔案：還原就是刪除檔案。
  - 指定好幾個檔案一次還原：在「變更」或「未追蹤」的檔案上 `⌘` 點選（Windows 為 `Ctrl`）加選、`⇧` 點選選取一段範圍，或勾選列左邊的勾選框；清單有焦點時 `⌘A` 全選、`Esc` 取消。清單頂端會出現「已選取 N 個檔案」與「↶ 還原所選」，右鍵也有「還原所選的 N 個檔案…」。確認時會列出要還原的檔案。已暫存的變更不能選取。
  - 比對畫面中每一段變更都有「↶ 還原此段」，只把那一段改回暫存區的內容。
  - 還原之後提示列有「復原」，可以把檔案改回來（保留最近 10 次操作，關閉 ToolDock 或停用擴充後就沒有了）。
  - 只改寫工作目錄中的檔案，**不修改暫存區、分支與提交**；已暫存與衝突的變更請用 Git 工具處理。檔案有尚未儲存的修改時不能還原。
- **檔案歷史**（檔案樹、分頁、異動清單的右鍵，或比對畫面的 🕘）：
  - 列出修改過這個檔案的提交（跟著重新命名往前找，最多 300 筆），可以切換「這次提交的變更」（上一版 ↔ 這一版）與「與目前檔案比較」。
  - 「還原成這個版本…」會把目前的檔案改成那個提交的內容，一樣可以復原。
- **差異比對**：
  - 點異動的檔案就開啟比對，可以切換「並排」與「行內」，兩側都有語法高亮。
  - 沒有變動的段落會摺疊（點一下展開），`↑`／`↓` 跳到上一處／下一處變更；雙擊某一行會開啟檔案並跳到那一行。
  - 已暫存：HEAD ↔ 暫存區；變更：暫存區 ↔ 工作目錄；未追蹤：整個檔案視為新增；合併衝突：HEAD ↔ 含衝突標記的工作目錄。

## 會讀寫的檔案與執行的程式

- **讀寫**：只讀寫你建立的專案資料夾，以及你用「開啟檔案」或「另存新檔」選擇的檔案。新增、重新命名都限制在專案資料夾內（會解析符號連結，避免跳到專案外）。
  跨檔案取代與 Git 還原也只會寫入專案資料夾內的檔案。符號索引（定義的名稱、行號與那一行的文字）存在擴充的資料夾裡，移除專案時一併刪除。為了「復原」，改寫前的內容會暫時留在記憶體中（不寫到磁碟），關閉後就清除。
- **擴充資料**：專案清單、各專案開著的檔案與展開的資料夾、最近開啟的檔案、自訂的快捷鍵，存在擴充的資料夾（`ctx.storage`）。
- **外部程式**：Git 功能會執行 `git`（`rev-parse`、`status`、`log`、`cat-file`、`ls-files`），**都是只讀取的指令，不會修改暫存區、分支與提交**；還原時由擴充自己寫入工作目錄的檔案，內容以 `git cat-file --filters` 取得，會套用換行轉換與 Git LFS 等過濾器，和 `git checkout` 寫出的內容相同。`status` 以 `GIT_OPTIONAL_LOCKS=0` 執行，不會和你自己的 git 指令搶鎖。找不到 git 時依序嘗試常見的安裝位置，也可以在設定 `codeEditor.gitPath` 指定。
- **反編譯**：開啟 `.class` 時執行 `java -jar vendor/cfr-0.152.jar <檔案> --silent true`（找 Java 時會執行 `java -version`，macOS 另外執行 `/usr/libexec/java_home`）；結果只顯示在分頁中，不寫入任何檔案。
- **網路**：不連網。

## 限制

- 檔案超過 50 MB，或前 8 KB 有 NUL 字元（二進位檔）時不顯示內容，可以改用預設應用程式開啟。
- 超過 1.5 MB 或 3 萬行的檔案不做語法高亮，以純文字編輯。
- 不是合法 UTF-8 的檔案以 Big5 解碼並設為唯讀（Node.js 沒有 Big5 編碼器，存回去會變亂碼）；另存新檔會存成 UTF-8。UTF-16 檔案同樣為唯讀。
- 差異比對超過 2,000 處差異時，中間整段視為刪除後新增。
- 跳到定義是依名稱比對，不懂型別：`a.save()` 會列出所有叫 `save` 的定義（同檔案與 import 的檔案排在前面）。超過 2 MB 的檔案不建立索引；寫在註解裡的定義寫法也可能被列出。
- 反編譯只處理單一 `.class` 檔，不能直接瀏覽 `.jar`；反編譯的結果不一定能重新編譯。
- 跨檔案搜尋不搜尋超過 10 MB 的檔案與二進位檔，最多列出 2 萬筆結果、搜尋 10 萬個檔案。Big5、UTF-16 等唯讀編碼的檔案可以搜尋，但不能取代。
- 不提供暫存、提交、取消暫存等會修改暫存區或分支的 Git 操作，請使用 Git 工具擴充。符號連結與子模組不能在這裡還原。

## 預設快捷鍵

macOS 以 `⌘`、Windows／Linux 以 `Ctrl` 表示。都可以在「鍵盤快捷鍵」面板修改。

| 功能 | macOS | Windows／Linux |
|---|---|---|
| 儲存／另存新檔 | `⌘S`／`⌥⌘S` | `Ctrl+S`／`Ctrl+Alt+S` |
| 新增未命名檔案／開啟檔案 | `⌘N`／`⌘O` | `Ctrl+N`／`Ctrl+O` |
| 搜尋檔名 | `⌘P` | `Ctrl+P` |
| 尋找／取代 | `⌘F`／`⌥⌘F` | `Ctrl+F`／`Ctrl+H`、`Ctrl+Alt+F` |
| 下一個／上一個符合的項目 | `⌘G`、`F3`／`⇧⌘G`、`⇧F3` | `F3`／`Shift+F3` |
| 在專案中搜尋／取代 | `⇧⌘F`／`⇧⌘H` | `Ctrl+Shift+F`／`Ctrl+Shift+H` |
| 前往行 | `⌃G`、`⌘L` | `Ctrl+G`、`Ctrl+L` |
| 跳到定義／尋找所有參考 | `F12`／`⇧F12` | `F12`／`Shift+F12` |
| 回到上一個／前往下一個位置 | `⌃-`／`⌃⇧-` | `Alt+←`／`Alt+→` |
| 切換行註解 | `⌘/` | `Ctrl+/` |
| 切換自動換行 | `⌥Z` | `Alt+Z` |
| 鍵盤快捷鍵 | `⌘K` | `Ctrl+K` |

> 1.0.0 的「另存新檔 `⇧⌘S`」與 macOS 的「取代 `⌘H`」其實會被 ToolDock 選單攔截（分別開啟擴充商店、隱藏 ToolDock），所以預設改為 `⌥⌘S` 與 `⌥⌘F`。

## 設定

| 設定 | 預設 | 說明 |
|---|---|---|
| `codeEditor.fontSize` | 13 | 字級（像素） |
| `codeEditor.tabSize` | 4 | Tab 寬度 |
| `codeEditor.insertSpaces` | true | 按 Tab 時插入空白 |
| `codeEditor.wordWrap` | false | 自動換行 |
| `codeEditor.exclude` | `node_modules, .git, .svn, .hg, .DS_Store, Thumbs.db, __pycache__` | 檔案樹排除，逗號分隔，可用 `*` |
| `codeEditor.searchExclude` | `Pods, DerivedData, .expo, .next, .nuxt, .gradle, .dart_tool, .venv, venv, bower_components, coverage, *.min.js, *.min.css, *.map` | 跨檔案搜尋與跳到定義不看的檔案或資料夾，逗號分隔，語法同 `.gitignore`（名稱比對任何一層，含 `/` 的路徑從專案根目錄算起） |
| `codeEditor.searchUseGitignore` | true | 跨檔案搜尋與跳到定義略過 `.gitignore` 忽略的檔案 |
| `codeEditor.gitPath` | （空白） | git 執行檔，留空時自動尋找 |
| `codeEditor.javaPath` | （空白） | 反編譯用的 java 執行檔或 JDK 資料夾，留空時自動尋找；有設定時只用這個路徑 |

## 測試

```bash
npm test
```

測試編輯核心（語言判斷、高亮分行、縮排、註解、Myers 差異比對與摺疊、變更分段、搜尋與取代字串、檔案篩選樣式、各語言的定義規則、import 來源與定義排序）、符號索引（增量更新、排除、不分大小寫）、class 檔大綱與 CFR 反編譯（需要 JDK，沒有時略過）、檔案讀寫（CRLF、BOM、二進位、Big5、路徑限制）、跨檔案搜尋與取代（排除、取消、原文檢查、復原），以及在暫存的 Git 儲存庫中實際執行異動清單、三種比對、整檔與逐段還原、檔案歷史與還原成歷史版本。需要安裝 git。

## 開發

需要先安裝 ToolDock 和 Node.js 18 以上。

| 指令 | 說明 |
|---|---|
| `npm run dev` | 以開發模式啟動 ToolDock 並載入這個擴充。存檔後會自動重新載入後端和畫面 |
| `npm run debug` | 同上，並開啟後端偵錯埠 `127.0.0.1:9229` |
| `npm run validate` | 檢查 manifest、檔案和相依套件 |
| `npm run pack` | 打包成 `dist/code-editor-<版本>.tbx`，只含正式相依 |
| `npm run install-local` | 打包並安裝到本機的 ToolDock |

開發模式使用獨立的資料目錄（`ToolDock-ExtDev`），可以和平常使用的 ToolDock 同時開啟。

> 1.9.0 起這個 repo 是唯一的原始碼。ToolDock repo 的自我測試會從平台 repo 旁的這個資料夾以連結方式安裝，測試畫面與 Git 比對，修改後可以在 ToolDock repo 執行 `npm run selftest` 一併確認。

## 發佈

推送 `v*` tag 後，GitHub Actions（`.github/workflows/release.yml`）會自動驗證、執行測試、打包、簽章，並建立 GitHub Release。ToolDock 商店會從 Release 下載並驗證簽章。

```bash
npm version patch        # 或 minor / major；會更新 package.json 並建立 v<版本> tag
git push --follow-tags
```

需要的設定（repo → Settings → Secrets and variables → Actions）：

| 種類 | 名稱 | 內容 |
|---|---|---|
| Secret | `TOOLDOCK_SIGNING_KEY` | ToolDock 發佈金鑰的私鑰（PEM 檔完整內容） |
| Variable | `TOOLDOCK_PUBLIC_KEY` | 公鑰字串，CI 發佈前會再驗證一次 |

Release 會附上 `code-editor-<版本>.tbx`、`.tbx.sha256`、`.tbx.sig`。詳見 ToolDock 的 [docs/RELEASE.md](https://github.com/tooldock-dev/tooldock-releases/blob/main/docs/RELEASE.md)。

## 專案結構

```
backend/
  index.js      啟用、專案清單、畫面呼叫的方法、指令
  files.js      目錄列表、檔名搜尋、讀寫、新增與重新命名
  search.js     跨檔案搜尋與取代
  ignore.js     搜尋範圍：搜尋排除設定與 .gitignore 規則
  edits.js      改寫檔案前的備份與復原
  symbols.js    符號索引（跳到定義）
  decompile.js  .class 反編譯（CFR），找 Java
  classfile.js  .class 解析，沒有 Java 時顯示類別結構
  git.js        git status 解析、比對兩側的內容、還原、檔案歷史
ui/
  index.html    畫面
  app.css       樣式（含深淺色語法顏色與差異配色）
  app.js        專案、檔案樹、編輯器、分頁、尋找取代、跨檔案搜尋、Git、差異比對、還原與檔案歷史
  code-core.js  純函式：語言判斷、高亮分行、縮排、註解、Myers 差異比對、搜尋與取代、檔案篩選樣式、定義規則與排序
vendor/
  cfr-0.152.jar CFR 反編譯器（MIT 授權，見 vendor/README.md 與 CFR-LICENSE.txt）
test/
```

## 授權

使用的 highlight.js 採 BSD-3-Clause 授權，授權條款隨套件附在 `node_modules/highlight.js/LICENSE`。

附帶的 CFR 0.152（Lee Benfield）採 MIT 授權，未經修改，取自 Maven Central；來源、SHA-1／SHA-256 與授權條款見 `vendor/README.md`、`vendor/CFR-LICENSE.txt`。
