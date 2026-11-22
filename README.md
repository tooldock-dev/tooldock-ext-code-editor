# 💻 程式碼編輯器

ToolDock 擴充：像記事本一樣輕巧的程式碼編輯器。建立專案、瀏覽資料夾、語法高亮編輯，並查看 Git 異動與差異比對。

ToolDock 1.8.0 起已內建這個擴充；1.4.0 到 1.7.x 的使用者可以從擴充商店安裝。商店發佈新版時，內建版本也會收到更新。

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
  - `⌘F` 尋找、`⌘H` 取代（可區分大小寫、使用規則運算式）、`⌃G` 前往行（可輸入「行:欄」）。
  - 狀態列可以切換自動換行、縮排方式（空格／Tab）與換行字元（LF／CRLF）。
  - 存檔時保留原本的換行字元與 BOM。
  - 檔案在外部被修改時自動重新載入；這裡也有未儲存的修改時，會先詢問。
- **Git 異動清單**：
  - 「變更」分頁顯示目前分支、領先／落後的提交數與最近一次提交。
  - 異動分成合併衝突、已暫存、變更、未追蹤四組；檔案樹也會標示有異動的檔案與資料夾。
  - 專案是儲存庫的子資料夾時，只列出這個資料夾內的異動。
- **差異比對**：
  - 點異動的檔案就開啟比對，可以切換「並排」與「行內」，兩側都有語法高亮。
  - 沒有變動的段落會摺疊（點一下展開），`↑`／`↓` 跳到上一處／下一處變更；雙擊某一行會開啟檔案並跳到那一行。
  - 已暫存：HEAD ↔ 暫存區；變更：暫存區 ↔ 工作目錄；未追蹤：整個檔案視為新增；合併衝突：HEAD ↔ 含衝突標記的工作目錄。

## 會讀寫的檔案與執行的程式

- **讀寫**：只讀寫你建立的專案資料夾，以及你用「開啟檔案」或「另存新檔」選擇的檔案。新增、重新命名都限制在專案資料夾內（會解析符號連結，避免跳到專案外）。
- **擴充資料**：專案清單、各專案開著的檔案與展開的資料夾、最近開啟的檔案，存在擴充的資料夾（`ctx.storage`）。
- **外部程式**：查看 Git 異動時會執行 `git`（`rev-parse`、`status`、`log`、`cat-file`），**只讀取，不會修改儲存庫**；`status` 以 `GIT_OPTIONAL_LOCKS=0` 執行，不會和你自己的 git 指令搶鎖。找不到 git 時依序嘗試常見的安裝位置，也可以在設定 `codeEditor.gitPath` 指定。
- **網路**：不連網。

## 限制

- 檔案超過 50 MB，或前 8 KB 有 NUL 字元（二進位檔）時不顯示內容，可以改用預設應用程式開啟。
- 超過 1.5 MB 或 3 萬行的檔案不做語法高亮，以純文字編輯。
- 不是合法 UTF-8 的檔案以 Big5 解碼並設為唯讀（Node.js 沒有 Big5 編碼器，存回去會變亂碼）；另存新檔會存成 UTF-8。UTF-16 檔案同樣為唯讀。
- 差異比對超過 2,000 處差異時，中間整段視為刪除後新增。
- 不提供暫存、提交、還原等會修改儲存庫的 Git 操作。

## 設定

| 設定 | 預設 | 說明 |
|---|---|---|
| `codeEditor.fontSize` | 13 | 字級（像素） |
| `codeEditor.tabSize` | 4 | Tab 寬度 |
| `codeEditor.insertSpaces` | true | 按 Tab 時插入空白 |
| `codeEditor.wordWrap` | false | 自動換行 |
| `codeEditor.exclude` | `node_modules, .git, .svn, .hg, .DS_Store, Thumbs.db, __pycache__` | 檔案樹排除，逗號分隔，可用 `*` |
| `codeEditor.gitPath` | （空白） | git 執行檔，留空時自動尋找 |

## 測試

```bash
npm test
```

測試編輯核心（語言判斷、高亮分行、縮排、註解、Myers 差異比對與摺疊）、檔案讀寫（CRLF、BOM、二進位、Big5、路徑限制），以及在暫存的 Git 儲存庫中實際執行異動清單與三種比對。需要安裝 git。

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

> 這個擴充同時是 ToolDock 的內建擴充，原始碼也放在 ToolDock repo 的 `extensions/code-editor/`。兩邊的 `backend/`、`ui/`、`test/` 應保持一致：先在其中一邊修改，再同步到另一邊。

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
  git.js        git status 解析、比對兩側的內容
ui/
  index.html    畫面
  app.css       樣式（含深淺色語法顏色與差異配色）
  app.js        專案、檔案樹、編輯器、分頁、尋找取代、Git 與差異比對
  code-core.js  純函式：語言判斷、高亮分行、縮排、註解、Myers 差異比對
test/
```

## 授權

使用的 highlight.js 採 BSD-3-Clause 授權，授權條款隨套件附在 `node_modules/highlight.js/LICENSE`。
