# Site Expenditure Tracker

A simple daily expenditure tracker for work sites. Open one link on any phone or computer to see every record. Only your devices can add or change anything.

## Set it up once (about 10 minutes)
1. **Upload the app.** On the repo page, click **Add file → Upload files**. Drag in everything from the app folder (including `lib`), then click **Commit changes**.
2. **Make the repo public** so GitHub Pages is free: **Settings → General → Danger Zone → Change visibility → Public**. Only the app code and *encrypted* records are in it. Without your link, nobody can read the records.
3. **Turn on the web address:** **Settings → Pages → Branch: main, folder / (root) → Save**. After 1–2 minutes your app opens at `https://gatoyah.github.io/Site_Expenditure_Recorder/`.
4. **Create your GitHub key** (this is what lets you save):
   - GitHub → your photo → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
   - Expiration: the longest offered. Repository access: **Only select repositories → Site_Expenditure_Recorder**.
   - Permissions → Repository permissions → **Contents: Read and write**.
   - Generate it, then copy it (it starts with `github_pat_`).
5. **Open the app address**, press **Online** (top right) and fill in:
   - **GitHub key**: paste it.
   - **Starting data**: choose `Berekum_Starting_Data.json` (all your Berekum funds and entries).
   - Press **Connect**.
6. It shows **your link** (ends with `#k=…`). Copy it and keep it safe. **This link is how you open your records anywhere.**

## Using it on any phone or computer
- **Just to read** (any phone, even someone else's): open your link. Everything shows, *View only*.
- **To add entries on a device**: open your link, press **View only** at the top, and paste your GitHub key once. That device remembers it.
- Every Insert is saved online straight away. The top button shows **Saved online ✓**. With no network it shows *Not saved online yet* and uploads by itself when you're back online.
- On a borrowed phone: press **View only** → tick *Remove the records and link from this device* when you're done.
- If the key expires, GitHub stops your saves. Create a new key (step 4) and enter it again via the top button.

**Anyone with the link can read the records**, so share it only with your bosses. GitHub keeps every saved version of `data.enc`, so earlier versions can always be recovered.

## Daily use
1. Pick the site.
2. Under **Money from** choose:
   - **Funds already added**: pick the Fund ID (each shows its balance), or
   - **A new fund**: the next Fund ID (F11, F12 ...) fills in by itself. Add Date, Received From, Mode, Amount 1 and Amount 2.
3. Fill in **Used For**, **Category**, **Item** and **Amount (GH¢)**. The quantity boxes for that item appear by themselves (e.g. Cement (bags)). Use "+ Other quantities" for any other one.
4. Press **Insert**.

If you type a "Used For" you've used before, its Category and Item fill in by themselves.

## Tabs (same as the Excel sheets)
- **All Entries**: every entry, with search and filters by fund, category and item. Each entry can be edited or deleted.
- **Total**: Funds Received, Used and Balance. Click a fund to see its "Fund N" sheet (what it was used for).
- **Categories**: one table per category (Trench, Production Room ...) with Item, Quantity and Total Amount.
- **Summary**: Total Received / Used / Balance, Spent On with % of Used, and every fund.
- **Site images**: add photos and an overview of the site. Only devices with your GitHub key can add or remove them.
- **POW**: upload the Programme of Works Excel to view and download it.
- **Settings**: change anything. Rename or reorder Categories, Items, Quantity columns and Modes. Set which quantities each item uses. Import entries from an Excel file in the same layout. Mark the site as *Done / transferred*.

**Download Excel** gives the same sheets as Site_Expenditure_Tracker.xlsx (Fund 1..N, each category, Total, All Entries, Summary). **Download PDF** gives a printable report.

**+ Add new site** on the first screen is for when you're transferred. You can copy the categories and items from another site.

Berekum Holy Family's funds (F1 to F10) and entries come from `Berekum_Starting_Data.json`. That file is kept out of the repo so the records are never stored unencrypted. Komfo Anokye and Tamale start empty.

## Backups
**Backup** saves one file with everything, images included. Keep a copy on Google Drive now and then. **Restore** puts a backup back, on this device and online.
