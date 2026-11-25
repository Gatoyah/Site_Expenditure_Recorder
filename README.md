# Site Expenditure Tracker

A simple daily expenditure tracker for work sites. It runs in your browser with no install, no login and no internet needed.

## How to open it
1. Download this repository (green **Code** button → **Download ZIP**) and unzip it somewhere safe, e.g. `Documents\Site Expenditure Tracker`.
2. Double-click `index.html`. Use **Chrome** or **Edge**, not a private window.
3. Tip: bookmark it, or right-click `index.html` → Send to → Desktop (create shortcut).

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
- **Site images**: only the owner PIN can add or remove images. Everyone else sees *View only*. Press **Owner** to set the PIN the first time.
- **POW**: upload the Programme of Works Excel to view and download it.
- **Settings**: change anything. Rename or reorder Categories, Items, Quantity columns and Modes. Set which quantities each item uses. Import entries from an Excel file in the same layout. Mark the site as *Done / transferred*.

**Download Excel** gives the same sheets as Site_Expenditure_Tracker.xlsx (Fund 1..N, each category, Total, All Entries, Summary). **Download PDF** gives a printable report.

**+ Add new site** on the first screen is for when you're transferred. You can copy the categories and items from another site.

Berekum Holy Family starts with all the funds (F1 to F10) and entries from the Excel. Komfo Anokye and Tamale start empty.

## Your data and backups
Data is saved **in the browser on this computer**. Clearing browser data deletes it, so:
- Press **Backup** regularly (e.g. weekly). It saves a `.json` file to Downloads. Keep a copy on Google Drive or a flash drive.
- To move to a new computer, or to let your boss view everything, open the app there and press **Restore** with the backup file.
