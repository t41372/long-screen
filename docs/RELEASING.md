# 發布套件：第一次發布的步驟

這份文件說明怎麼把 Long Screen 的三個套件第一次發布到 crates.io、PyPI 和 npm（2026-10-12 已照著做完一次），以及之後每個版本怎麼發。內容依 2026-10-11 各註冊表（registry）自己的文件寫成，來源列在文末；這些網站的設定頁面常常改版，按鈕名稱和這裡不一樣時，以網站上的為準，並回頭更新這份文件。

整份文件用同一個記號標出不能撤回的動作：**【不可撤回】**。看到這個記號的步驟，做之前先把該步驟前面的檢查全部做完。

## 1. 要發布什麼

| 註冊表    | 套件名        | 原始碼                                                           | 發布用的標籤     | 工作流程（workflow）                   | 第一個版本怎麼發                      |
| --------- | ------------- | ---------------------------------------------------------------- | ---------------- | -------------------------------------- | ------------------------------------- |
| crates.io | `long-screen` | `rust/long-screen`（核心、引擎、解碼都是它裡面的模組）           | `crates-v<版本>` | `.github/workflows/release-crates.yml` | 用 API token 在本機手動發             |
| PyPI      | `long-screen` | `rust/python`                                                    | `py-v<版本>`     | `.github/workflows/python.yml`         | 由工作流程自動發（pending publisher） |
| npm       | `long-screen` | `src/package`，由 `deno task build:package` 建進 `dist-package/` | `npm-v<版本>`    | `.github/workflows/release-npm.yml`    | 從 GitHub 建好的 tarball 在本機手動發 |

三個 0.1.0 已在 2026-10-12 從 `748a0ac` 發布，名字都已經是這個專案的。之後的例行發布，`CONTRIBUTING.md` 的維護者指南有白話的簡短版本；這份文件留著完整的步驟和第一次發布的紀錄。

不發布的：網頁版本身（由 Cloudflare Pages 從 `main` 部署）、`long-screen-wasm`、`long-screen-bench`、`long-screen-py`（它們的 `Cargo.toml` 都寫了 `publish = false`）。TypeScript 套件只發 npm，不發 JSR。

三個套件彼此獨立：Python 套件是從這個倉庫的 Rust 原始碼直接編譯的，不依賴 crates.io 上的 crate；npm 套件也一樣。所以三個註冊表可以照任何順序發，版本號以後也可以各走各的。

## 2. 推送和標籤會觸發什麼

先弄清楚每個 `git push` 會引發什麼，這是整個流程裡最容易出錯的地方。

| 推送的東西                       | 觸發                                                                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `main` 分支                      | Cloudflare Pages 把網站部署到正式環境（https://long-screen.yi-ting.com 和 https://long-screen.pages.dev），也會跑 CodSpeed 基準測試 |
| 其他分支                         | Cloudflare Pages 的預覽部署                                                                                                         |
| 標籤 `crates-v<版本>`            | `release-crates.yml`：在 Linux、macOS、Windows 上打包並測試，然後用可信發布（trusted publishing）發到 crates.io                     |
| 標籤 `py-v<版本>`                | `python.yml`：建出各平台的 wheel 和 sdist、測試，然後用可信發布發到 PyPI                                                            |
| 標籤 `npm-v<版本>`               | `release-npm.yml`：建出 npm 套件並打包，然後用可信發布發到 npm（帶 provenance）                                                     |
| 其他標籤（例如 `test-cases-v1`） | 不觸發任何發布                                                                                                                      |

幾件要記住的事：

- 標籤不會部署網站，但標籤指向的那個 commit 必須已經在 GitHub 上。實際做法是先把要發布的 commit 推到 `main`（這一步會部署網站），再打標籤。本機 `main` 上還沒推送的 commit 會隨這一步一起上線，所以推之前先確認它們都可以上線。
- 標籤觸發的工作流程，用的是標籤所指 commit 裡的那份 workflow 檔。各註冊表的可信發布設定會寫死 workflow 的檔名（`release-crates.yml`、`python.yml`、`release-npm.yml`）和 GitHub 環境（environment）名稱，改檔名或改環境名，發布就會被拒絕，要同時去註冊表改設定。
- 一次只推一個標籤：`git push origin <標籤名>`。不要用 `git push --tags`，它會把本機所有標籤一起推上去。
- 所有標籤都用附註標籤（annotated tag）：`git tag -a py-v0.1.0 -m "Python package 0.1.0" <commit>`。

## 3. 版本號寫在哪裡

| 套件   | 版本號所在                                                                                    | 誰檢查                                            |
| ------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| crate  | `rust/long-screen/Cargo.toml` 的 `version`                                                    | `release-crates.yml` 檢查它和 `crates-v` 標籤一致 |
| Python | `rust/python/Cargo.toml` 的 `version`（`pyproject.toml` 的 `dynamic = ["version"]` 從這裡讀） | `python.yml` 的發布步驟檢查它和 `py-v` 標籤一致   |
| npm    | `deno.json` 的 `version`（`scripts/build-package.ts` 把它抄進 `package.json`）                | `release-npm.yml` 檢查它和 `npm-v` 標籤一致       |

目前三者都是 `0.1.0`。之後發新版本的順序永遠是：改版本號 → commit → 推 `main` → 打標籤 → 推標籤。標籤和檔案裡的版本不一致時，工作流程會在發布之前停下來，什麼都不會上傳。

版本號一旦在某個註冊表用過，就永遠不能再用一次（見第 9 節）。所以發布之前多看一眼版本號，比發布之後補救便宜得多。

## 4. 一次性準備：帳號和 GitHub 環境

### 4.1 GitHub 環境

可信發布的意思是：註冊表不再收一個長期有效的密碼或 token，而是信任「某個 GitHub 倉庫裡某個 workflow 檔、在某個環境裡跑的工作」。GitHub 在工作執行時發一張短期的 OIDC 身分證明，註冊表核對倉庫、workflow 檔名和環境都對得上，才換給它一個幾十分鐘內有效的發布權限。所以倉庫裡不用存任何發布用的祕密。

三個工作流程用的環境分別是 `crates-io`、`pypi` 和 `npm`。GitHub 會在工作流程第一次用到時自動建立同名環境，但自動建立的環境沒有任何保護規則，建議事先手動建好：

1. 打開 https://github.com/t41372/long-screen/settings/environments ，按 **New environment**，名稱輸入 `crates-io`，按 **Configure environment**。
2. 在 **Deployment branches and tags** 選 **Selected branches and tags**，按 **Add deployment branch or tag rule**，類型選 **Tag**，樣式填 `crates-v*`。這樣只有 `crates-v` 開頭的標籤能用這個環境發布。
3. （建議）勾 **Required reviewers**，加入你自己。每次發布到最後一步時，工作流程會停下來等你在 Actions 頁面按 **Review deployments → Approve**，等於多一個「確定要發布嗎」的按鈕。只有你一個維護者時，**不要**勾 **Prevent self-review**，否則你自己推的標籤沒有人能核准。
4. 按 **Save protection rules**。
5. 對 `pypi`（標籤樣式 `py-v*`）和 `npm`（標籤樣式 `npm-v*`）重複一次。

公開倉庫在 GitHub Free 方案就能用環境和 required reviewers。

### 4.2 crates.io 帳號

1. 打開 https://crates.io ，按右上角 **Log in with GitHub**，授權 crates.io 讀取你的 GitHub 帳號。crates.io 目前只能用 GitHub 登入。
2. 到 **Account Settings**（https://crates.io/settings/profile ）填入電子郵件，按信裡的連結完成驗證。沒有驗證過的電子郵件，crates.io 不讓你發布。
3. 發布用的 API token 等到真正要發布時才建立（第 6.2 節），用完就撤銷。

### 4.3 PyPI 帳號

你已經有 PyPI 帳號。PyPI 要求所有帳號開啟兩步驟驗證（2FA），登入 https://pypi.org/manage/account/ 確認已開啟，並確認恢復碼（recovery codes）存在安全的地方。PyPI 這邊不需要任何 token。

### 4.4 npm 帳號

1. 到 https://www.npmjs.com/signup 註冊。使用者名稱只能用小寫字母、數字和連字號。
2. 收信驗證電子郵件。沒有驗證過的電子郵件不能發布。注意：發布者的電子郵件會出現在套件的公開中繼資料裡，任何人下載套件都看得到，所以選一個你願意公開的信箱。
3. 開啟兩步驟驗證：npmjs.com 右上角頭像 → **Account** → **Two-Factor Authentication**，依指示加入安全金鑰（security key / passkey）。恢復碼存在手機以外的地方；npm 說明用恢復碼登入會讓帳號進入 72 小時的安全鎖定。
4. 在終端機執行 `npm login`，它會開瀏覽器讓你登入；再執行 `npm whoami`，印出你的使用者名稱就代表成功。`npm login` 給的是兩小時有效的工作階段，過期後重新 `npm login` 即可。

關於 npm token 的現況：舊式的 classic token 已在 2025 年底全部撤銷；細粒度 token（granular access token）還在，但「略過 2FA」的 token 預計 2027 年 1 月左右失去直接發布的能力。這個倉庫的發布流程完全不用 npm token：第一版用你本機的 `npm login`，之後用可信發布。

## 5. 每次發布前的檢查

以下在要發布的那個 commit 上做。不要一邊改檔案一邊發布。

1. 確認工作區乾淨：`git status` 沒有任何改動，`git log -1` 就是要發布的 commit。`cargo publish` 遇到未提交的改動會拒絕發布；**不要**用 `--allow-dirty` 繞過它。
2. 跑測試和檢查：`deno task lint`、`deno task test`。發 Python 套件時再跑 `deno task test:python`；發 npm 套件時再跑 `deno test --allow-all tests/browser/package.test.ts`（真的開 Chrome 和 WebKit 跑一次套件，要幾分鐘）。
3. crate 的試發布：`cd rust && cargo publish --dry-run --locked -p long-screen`。它會打包、把打包結果解開重新編譯一次，最後印出 `aborting upload due to dry run`。想看包裡有哪些檔案，用 `cargo package --list -p long-screen`。
4. npm 套件的試打包：`deno task build:package`，然後 `cd dist-package && npm pack --dry-run`。應該列出 12 個檔案（`index.js`、`index.d.ts`、`worker.js`、`core-helper.js`、`convert-worker.js`、三個 `core*.wasm`、`package.json`、`README.md`、`LICENSE`、`THIRD_PARTY_NOTICES.txt`），壓縮後約 1.6 MB；`name` 是 `long-screen`，`version` 是要發的版本。
5. 確認三個版本號（第 3 節）都是你要的。
6. 把這個 commit 推到 `main`（`git push origin main`）。**這一步會部署網站。** 等 Cloudflare Pages 部署完成，打開 https://long-screen.yi-ting.com 確認網站正常。

## 6. 第一次發布：建議順序

建議順序是：GitHub 上的預檢 → PyPI → crates.io → npm。順序本身不影響結果（三者互相獨立），這樣排是因為 PyPI 的第一版可以全自動，而且 Python 的工作流程會在 Linux、macOS、Windows 三個系統上編譯同一份 Rust 原始碼，等於幫接下來要手動發的 crate 先做了一次跨平台檢查。

### 6.0 在 GitHub 上預檢（不會發布任何東西）

1. 打開 https://github.com/t41372/long-screen/actions/workflows/python.yml ，按 **Run workflow**，分支選 `main`，執行。它會建出五個平台的 wheel 和 sdist 並跑測試，但不會發布（只有 `py-v` 標籤會發布）。
2. 打開 https://github.com/t41372/long-screen/actions/workflows/release-npm.yml ，同樣按 **Run workflow**，分支選 `main`。它會建出 npm 套件，把 tarball 存成這次執行的附件（artifact）`npm-package`，不會發布。記下這次執行的編號（網址裡 `/runs/` 後面的數字），第 6.3 節要用。
3. 打開 https://github.com/t41372/long-screen/actions/workflows/release-crates.yml ，同樣按 **Run workflow**，分支選 `main`。手動執行只跑檢查：在 Linux、macOS、Windows 上打包 crate、從打包結果編譯並跑測試，Linux 上再把打包結果不帶預設 feature 編譯成 wasm32（網頁用的形狀），不會發布（只有 `crates-v` 標籤會發布）。
4. 三個都要綠燈才往下走。失敗的話先修，修好推 `main` 再跑一次。

### 6.1 PyPI（第一版自動發布）

PyPI 允許在專案還不存在時就先設定可信發布者，叫做 pending publisher。第一次發布成功時，PyPI 才建立專案，pending publisher 自動變成正式的可信發布者。

1. 登入 PyPI，打開 https://pypi.org/manage/account/publishing/ （帳號選單裡的 **Publishing**，不是某個專案的設定頁，因為專案還不存在）。
2. 在 **Add a new pending publisher** 選 **GitHub**，填入：
   - **PyPI Project Name**：`long-screen`
   - **Owner**：`t41372`
   - **Repository name**：`long-screen`
   - **Workflow name**：`python.yml`
   - **Environment name**：`pypi`
3. 按 **Add**。pending publisher 不會替你保留名字：如果別人在你發布前先註冊了 `long-screen`，這個設定就作廢。所以設定完盡快做下一步。
4. **【不可撤回】** 打標籤並推送：

   ```sh
   git tag -a py-v0.1.0 -m "Python package 0.1.0" <要發布的 commit>
   git push origin py-v0.1.0
   ```

5. 到 https://github.com/t41372/long-screen/actions 看「Python package」這次執行。建置和測試跑完後，發布工作會先檢查標籤和 `rust/python/Cargo.toml` 的版本一致；如果 `pypi` 環境設了 required reviewers，這時按 **Review deployments → Approve**。上傳時預設會附上數位證明（attestations）。
6. 驗證：打開 https://pypi.org/project/long-screen/ ，應該看到 0.1.0、五個 wheel 和一個 sdist。在一個全新的虛擬環境裡 `pip install long-screen==0.1.0`，執行 `python -c "import long_screen; print(long_screen.__name__)"`。

### 6.2 crates.io（第一版手動發布）

crates.io 的可信發布只能用在已經存在的 crate 上，新 crate 一定要先用 API token 手動發一次。

1. 在要發布的 commit 上，`cd rust && cargo publish --dry-run --locked -p long-screen`，確認通過（第 5 節）。
2. 建立一個只能做這件事的 token：打開 https://crates.io/settings/tokens/new ，
   - **Name**：例如 `long-screen first publish`
   - **Expiration**：選 **7 days**
   - **Scopes**：只勾 `publish-new`（發布新的 crate）
   - **Crates**：加一個樣式 `long-screen`
   - 按 **Generate Token**，複製 token。離開頁面後就再也看不到它了。
3. 在終端機執行 `cargo login`，貼上 token。它存在 `~/.cargo/credentials.toml`。
4. **【不可撤回】** 發布：

   ```sh
   cd rust
   cargo publish --locked -p long-screen
   ```

   cargo 會再驗證一次，然後上傳。一個新 crate 遠低於 crates.io 的頻率限制（一個帳號一次最多連發 5 個新 crate）。
5. 立刻收回 token：回到 https://crates.io/settings/tokens 按 **Revoke**，再執行 `cargo logout`。
6. 驗證：打開 https://crates.io/crates/long-screen 。docs.rs 幾分鐘後會自動建出文件（https://docs.rs/long-screen ），確認沒有建置失敗。在一個暫時的目錄裡執行 `cargo install long-screen`，確認 `long-screen --help` 能跑。
7. 設定可信發布：打開 https://crates.io/crates/long-screen/settings ，在 **Trusted Publishing** 按 **Add**，選 **GitHub**，填入：
   - **Repository owner**：`t41372`
   - **Repository name**：`long-screen`
   - **Workflow filename**：`release-crates.yml`
   - **Environment**：`crates-io`
8. 手動發布、設好可信發布之後，在同一個 commit 上推 `crates-v0.1.0` 標籤：`git tag -a crates-v0.1.0 -m "crate 0.1.0" <commit>` → `git push origin crates-v0.1.0`。工作流程照樣在三個系統上檢查；發布那一步先查 crates.io，看到 0.1.0 已經在上面就跳過上傳，整次執行是綠燈，並留下一則「already on crates.io; nothing to publish」的說明。這樣 0.1.0 和之後的版本一樣有標籤可查。之後的版本（0.1.1 起）由標籤發布。
9. crates.io 的 crate 設定裡還有一個「只允許可信發布」（Trusted Publishing only）的選項，開啟後 API token 就不能再發新版本。建議等第一次用標籤自動發布成功之後再開：開了之後，萬一工作流程出問題，就沒有手動發布這條退路了（要先把它關掉）。

之後的版本：改 `rust/long-screen/Cargo.toml` 的版本 → commit → 推 `main` → `git tag -a crates-v0.1.1 -m "crate 0.1.1" <commit>` → `git push origin crates-v0.1.1`。工作流程先在三個系統上打包、編譯、跑測試，全部通過才由 `rust-lang/crates-io-auth-action` 換到一個 30 分鐘有效的 token 發布，工作結束時 token 自動撤銷。crates.io 會寄信通知每一次發布。

### 6.3 npm（第一版手動發布）

npm 的可信發布設定在套件自己的設定頁裡，套件還不存在就沒有地方設定。所以第一版由你本機發布，但發的是 GitHub 在 6.0 節建好的那個 tarball，而不是本機另外建一份，這樣發出去的檔案就是工作流程以後也會建出的同一種東西。

1. 下載 6.0 節那次執行的附件（`<run-id>` 換成你記下的編號）：

   ```sh
   gh run download <run-id> -R t41372/long-screen -n npm-package -D ~/Downloads/long-screen-npm-0.1.0
   tar -tzf ~/Downloads/long-screen-npm-0.1.0/long-screen-0.1.0.tgz
   ```

   也可以在那次執行的頁面最下方 **Artifacts** 直接下載 zip 再解開。確認 `tar -tzf` 列出的是第 5 節那 12 個檔案（都在 `package/` 底下）。
2. `npm login`，然後 `npm whoami` 確認登入的是你的帳號。
3. **【不可撤回】** 發布：

   ```sh
   npm publish ~/Downloads/long-screen-npm-0.1.0/long-screen-0.1.0.tgz --access public
   ```

   npm 會要求 2FA 驗證。本機發布的版本沒有 provenance（provenance 只有在 CI 裡發布才會產生），之後從工作流程發的版本才會有。

   另一個選擇是用 npm 的分段發布（staged publishing）：把上面的 `npm publish` 換成 `npm stage publish`（需要 npm 11.15.0 以上），檔案會先進入待審區，不會公開；你到 npmjs.com 套件頁的 **Staged Packages** 分頁檢查後按 **Approve**（要過 2FA）才真正公開。npm 從 2026-10-02 起允許用這個方式建立全新的套件。多一道人工確認，但步驟也多一步，選哪個都可以。
4. 驗證：打開 https://www.npmjs.com/package/long-screen ，執行 `npm view long-screen`。在一個暫時的資料夾裡 `npm init -y && npm install long-screen`，確認 `node_modules/long-screen/` 裡有那 12 個檔案。
5. （可選）推 `npm-v0.1.0` 標籤當作紀錄：`git tag -a npm-v0.1.0 -m "npm package 0.1.0" <commit>`、`git push origin npm-v0.1.0`。工作流程會重新建置，發現 0.1.0 已經在 npm 上，就只印一行說明，不會發布。如果 `npm` 環境設了 required reviewers，它仍會停下來等你核准，核准後才去檢查版本，這是正常的。
6. **現在先不要設定 npm 的可信發布。** npm 規定新建的可信發布設定必須在 2 天（48 小時）內成功發布一次，否則設定會失效，要刪掉重建。所以等到要發下一個版本、準備好要推標籤的那一天，再做第 7 節的設定。

## 7. npm 之後的版本：設定可信發布

在要推下一個 `npm-v` 標籤的當天做：

1. 打開 https://www.npmjs.com/package/long-screen/access （套件頁 → **Settings**），找到 **Trusted Publisher**，選 **GitHub Actions**，填入：
   - **Organization or user**：`t41372`
   - **Repository**：`long-screen`
   - **Workflow filename**：`release-npm.yml`（只填檔名，不含路徑）
   - **Environment name**：`npm`
   - **Allowed actions**：勾 **npm publish**。2026-09-03 之後新建的設定預設只允許 `npm stage publish`，而 `release-npm.yml` 用的是 `npm publish`，不勾的話發布會被拒絕。
2. npm 存檔時不會檢查這些欄位對不對，打錯要到發布時才會知道。設定不能編輯，只能刪掉重建。
3. 改 `deno.json` 的 `version` → commit → 推 `main` → `git tag -a npm-v0.1.1 -m "npm package 0.1.1" <commit>` → `git push origin npm-v0.1.1`。工作流程建置、打包，檢查標籤和版本一致，然後用可信發布上傳，provenance 會自動附上（套件的 `repository` 欄位必須和 GitHub 倉庫一致，現在是一致的）。
4. 第一次用工作流程發布成功後，到套件設定的 **Publishing access** 選 **Require two-factor authentication and disallow tokens**。這只擋傳統 token，可信發布不受影響。

如果想讓每次自動發布都要你在 npmjs.com 上再按一次核准，可以不勾 **npm publish**、只保留預設的 `npm stage publish`，並把 `release-npm.yml` 最後一行的 `npm publish` 改成 `npm stage publish`。npm 官方推薦這種做法；代價是每次發布多一步，而且 npm 的文件沒有說明分段發布的版本是否保留 provenance。

## 8. 發布之後

- 更新 README 的「Use it outside the browser」（安裝方式、註冊表連結、badge）和 `docs/ARCHITECTURE.md` 路線圖第 8 項。0.1.0 發布後已經做過。這是一般的文件 commit，推 `main` 會重新部署網站。
- 可以在 GitHub 的 **Releases** 頁面替標籤寫發布說明，這一步不影響任何註冊表。

## 9. 哪些事不能撤回

| 註冊表    | 已發布的版本能不能改或刪                                                                                                                                                                                                      | 補救方式                                                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| crates.io | 版本永遠不能覆寫，程式碼也不能刪。整個 crate 只有在發布未滿 72 小時，或「只有一個擁有者、每個月下載不到 1000 次、沒有其他 crate 依賴它」時才能刪；不要把刪除當成補救手段。                                                    | `cargo yank --version 0.1.0 long-screen`（需要有 `yank` 權限的 token）：新專案不會再選到這個版本，已經在用的不受影響，檔案也還在。`--undo` 可以取消。 |
| PyPI      | 刪除是永久的，而且同一個檔名永遠不能再上傳，即使刪掉專案再重建也一樣，所以等於這個版本號作廢。刪除整個專案會把名字讓給任何人。                                                                                                | 在專案的 **Manage → Releases** 把版本設為 yanked：安裝工具會略過它，除非有人指定這個確切版本。                                                        |
| npm       | 發布後 72 小時內，沒有其他套件依賴它時可以 `npm unpublish`；超過 72 小時，要同時滿足「上週下載少於 300 次、只有一個維護者、沒有其他套件依賴」。不論如何，用過的版本號永遠不能再用；整個套件都撤下後 24 小時內不能再發新版本。 | `npm deprecate long-screen@0.1.0 "說明"`：照樣可以安裝，但會顯示警告。                                                                                |

共通的規則：發錯了就發一個新的修正版本（例如 0.1.1），再把錯的版本 yank 或 deprecate。不要試圖「重發同一個版本號」，三個註冊表都不允許。

如果不小心把密碼、token 或私人資料發布出去：先立刻撤銷那個祕密，因為 yank 和 deprecate 都不會刪掉檔案。

## 10. 常見錯誤怎麼處理

**標籤打錯了（版本不一致、指錯 commit），而且還沒有任何東西發布出去。** 工作流程會在發布前的檢查停下來。刪掉標籤再重打：

```sh
git push origin :refs/tags/py-v0.1.0   # 刪掉 GitHub 上的標籤
git tag -d py-v0.1.0                   # 刪掉本機的標籤
# 修好版本號或選對 commit，推 main，再打一次標籤
```

只在確定註冊表上還沒有這個版本時才這樣做。版本已經發出去之後，標籤就留著，不要移動它。

**工作流程在發布之前失敗**（建置、測試、標籤檢查）。註冊表上什麼都沒有。如果是程式問題，修好、推 `main`，刪掉標籤、在新 commit 上重打；如果只是 GitHub 的暫時性錯誤（網路、執行器），在那次執行的頁面按 **Re-run failed jobs** 即可。

**發布步驟本身失敗。**

- 可信發布被拒絕（錯誤訊息通常提到 token exchange、OIDC 或 not authorized）：註冊表上的設定和實際不一致。逐項比對倉庫擁有者 `t41372`、倉庫名 `long-screen`、workflow 檔名、環境名稱。改好設定後按 **Re-run failed jobs**。npm 的設定只能刪掉重建，而且新設定又有 48 小時期限。
- PyPI 上傳到一半中斷：`python.yml` 設了 `skip-existing`，按 **Re-run failed jobs** 會跳過已經上傳的檔案，只補上剩下的。
- npm：發布是一次完成的，重跑時如果版本已經在 npm 上，工作流程只會印一行說明。
- crates.io：只有一個 crate，上傳是一次完成的。重跑時如果版本已經在 crates.io 上，發布步驟會跳過上傳、只留一則說明，代表上一次其實已經成功。

**本機手動發布時出現「already exists」或「cannot publish over the previously published versions」。** 這個版本號已經用掉了（可能是你自己剛剛發成功）。先到註冊表網頁確認；需要再發就改用下一個版本號。

**推了 `py-v` 標籤卻忘了先設 pending publisher。** 發布那一步會失敗，什麼都沒上傳。到 PyPI 補上第 6.1 節的設定，再按 **Re-run failed jobs**。

**npm 的可信發布設定過期了**（建立後 48 小時內沒有成功發布）。刪掉它，在要推標籤的當天重建。

**弄丟 2FA 裝置。** 用恢復碼登入，再重新設定 2FA。npm 用恢復碼登入會觸發 72 小時的帳號安全鎖定，期間不能發布。

## 11. 發布當天的檢查清單

一次性準備（只做一次）：

- [ ] GitHub 環境 `crates-io`、`pypi`、`npm` 已建立，各自限制標籤樣式 `crates-v*`、`py-v*`、`npm-v*`（第 4.1 節）
- [ ] crates.io 已用 GitHub 登入，電子郵件已驗證（第 4.2 節）
- [ ] PyPI 帳號已開 2FA（第 4.3 節）
- [ ] npm 帳號已註冊、電子郵件已驗證、2FA 已開、`npm whoami` 正常（第 4.4 節）

每次發布：

- [ ] 要發布的 commit 在 `main` 上，`git status` 乾淨（第 5 節）
- [ ] 版本號正確：crate 看 `rust/long-screen/Cargo.toml`，Python 看 `rust/python/Cargo.toml`，npm 看 `deno.json`（第 3 節）
- [ ] `deno task lint`、`deno task test` 通過；有發 Python 就加跑 `deno task test:python`，有發 npm 就加跑 `tests/browser/package.test.ts`
- [ ] `cargo publish --dry-run --locked -p long-screen` 通過
- [ ] `deno task build:package` 後，`npm pack --dry-run` 列出 12 個檔案、版本正確
- [ ] `git push origin main`，網站部署正常（這一步會更新正式網站）
- [ ] GitHub 上手動執行「Python package」、「npm package」和「Rust crates」工作流程，都是綠燈（第 6.0 節）

第一次發布（0.1.0）：

- [ ] PyPI pending publisher 已加（`long-screen` / `t41372` / `long-screen` / `python.yml` / `pypi`）
- [ ] **【不可撤回】** 推 `py-v0.1.0`，核准 `pypi` 環境，pypi.org 上看得到 0.1.0，`pip install` 正常
- [ ] crates.io token（7 天、只有 `publish-new`、限 `long-screen`）已建立並 `cargo login`
- [ ] **【不可撤回】** `cargo publish --locked -p long-screen`
- [ ] token 已撤銷、`cargo logout`；docs.rs 建置成功
- [ ] crates.io 可信發布已設定（`t41372` / `long-screen` / `release-crates.yml` / `crates-io`）
- [ ] 推 `crates-v0.1.0`（指向手動發布的 commit），工作流程綠燈、發布步驟說明 0.1.0 已存在而跳過
- [ ] 下載 npm 工作流程的 `npm-package` 附件，確認 12 個檔案
- [ ] **【不可撤回】** `npm publish long-screen-0.1.0.tgz --access public`（或 `npm stage publish` 後在網站核准）
- [ ] npmjs.com 上看得到 0.1.0；npm 的可信發布**先不設**
- [ ] 更新 README 的安裝說明（第 8 節）

之後的版本：

- [ ] 改版本號、commit、推 `main`
- [ ] 只有 npm：當天設好可信發布（勾 **npm publish**），48 小時內推標籤（第 7 節）
- [ ] **【不可撤回】** 推對應的標籤（`crates-v…`、`py-v…`、`npm-v…`），在 Actions 頁面核准環境
- [ ] 在註冊表網頁確認新版本

## 參考資料

以下頁面都在 2026-10-11 查過。

crates.io 與 cargo：

- 可信發布說明：https://crates.io/docs/trusted-publishing （頁面原始碼：https://github.com/rust-lang/crates.io/blob/main/svelte/src/routes/docs/trusted-publishing/+page.svelte ）
- 新增 API token 的頁面（權限 `publish-new`、`publish-update`、`yank`、`change-owners`、`trusted-publishing`，crate 名稱樣式，期限）：https://github.com/rust-lang/crates.io/blob/main/svelte/src/routes/settings/tokens/new/+page.svelte
- 可信發布 token 不能建立新 crate（`Trusted Publishing tokens do not support creating new crates`）：https://github.com/rust-lang/crates.io/blob/main/src/controllers/krate/publish.rs
- 「只允許可信發布」選項，以及 `pull_request_target`、`workflow_run` 觸發的工作被擋：https://blog.rust-lang.org/2026/01/21/crates-io-development-update
- 第一版必須手動發布：https://blog.rust-lang.org/2025/07/11/crates-io-development-update-2025-07
- RFC 3691（可信發布）：https://rust-lang.github.io/rfcs/3691-trusted-publishing-cratesio.html
- `rust-lang/crates-io-auth-action`：https://github.com/rust-lang/crates-io-auth-action
- 發布、`cargo login`、`--dry-run`、yank：https://doc.rust-lang.org/cargo/reference/publishing.html
- 頻率限制：https://crates.io/docs/rate-limits
- 刪除 crate 的條件：https://crates.io/policies

PyPI：

- 用 pending publisher 建立新專案：https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/
- 在工作流程中使用可信發布：https://docs.pypi.org/trusted-publishers/using-a-publisher/
- `pypa/gh-action-pypi-publish`（attestations 預設開啟、`skip-existing`）：https://github.com/pypa/gh-action-pypi-publish
- 檔名不能重複使用、刪除是永久的、yank、2FA：https://pypi.org/help/

npm：

- 建立帳號：https://docs.npmjs.com/creating-a-new-npm-user-account
- 兩步驟驗證：https://docs.npmjs.com/configuring-two-factor-authentication
- Token 的現況：https://docs.npmjs.com/about-access-tokens
- 可信發布（欄位、Allowed actions、2 天期限、禁止 token 的選項）：https://docs.npmjs.com/trusted-publishers
- Provenance：https://docs.npmjs.com/generating-provenance-statements
- 分段發布：https://docs.npmjs.com/staged-publishing
- 撤下套件的規則：https://docs.npmjs.com/policies/unpublish
- classic token 撤銷、`npm login` 兩小時工作階段：https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/
- 分段發布正式推出：https://github.blog/changelog/2026-05-22-staged-publishing-and-new-install-time-controls-for-npm/
- 略過 2FA 的 token 失去直接發布能力（約 2027 年 1 月）：https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/
- 多組可信發布設定、預設只能分段發布：https://github.blog/changelog/2026-09-03-multiple-trusted-publishing-configurations-for-npm/
- 分段發布可以建立新套件：https://github.blog/changelog/2026-10-02-npm-staged-publishing-now-supports-creating-new-packages/

GitHub：

- 環境、required reviewers、部署分支與標籤規則：https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
