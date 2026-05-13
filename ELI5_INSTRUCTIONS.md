# Setting Up Constellar — Beginner's Guide

If you've never run a Python project before, this is for you. By the end you'll have Constellar running on your computer, and (optionally) the AI features turned on. No prior experience assumed. Read straight through; skip nothing.

If you're already comfortable with Python virtual environments and API keys, use `INSTRUCTIONS.md` instead — it's much shorter and skips the explanations.

---

## What you'll need

- A Windows PC. (Mac/Linux work too but the commands look slightly different; I'll flag that where it matters.)
- About 15 minutes for the basic version, 10 more minutes for the AI features.
- A web browser.
- Optional, for the AI features: a credit card, since Anthropic's API isn't free (but it's cheap — a couple of dollars covers a lot of use).

---

# Part 1 — Get the basic version running

This part has no API keys, no payment, nothing optional. At the end you'll have Constellar reading RSS feeds + Reddit and showing them in a list + a constellation map.

## Step 1. Install Python

**What is Python?** It's the programming language Constellar is written in. You need it on your computer the same way you need a PDF reader to open PDFs.

1. Open your web browser and go to **<https://www.python.org/downloads/>**.
2. Click the big yellow button that says **"Download Python 3.13.x"** (the exact number doesn't matter, any 3.13+ is fine).
3. The installer downloads. Run it (it'll be in your Downloads folder, called something like `python-3.13.0-amd64.exe`).
4. **VERY IMPORTANT**: on the very first screen of the installer, there's a checkbox at the bottom labelled **"Add python.exe to PATH"**. **Tick it.** If you skip this, nothing else in this guide will work, and the fix is annoying.
5. Click **Install Now**. Wait about a minute.
6. When it says "Setup was successful", close the installer.

**Verify it worked:** open a fresh PowerShell window (click Start, type `powershell`, hit Enter). Type this and press Enter:

```
python --version
```

You should see `Python 3.13.0` or similar. If you see "command not found" or "the term 'python' is not recognized", the PATH checkbox was missed — uninstall Python, reinstall, and make sure you tick the box this time.

> **Avoid the Microsoft Store version of Python.** Windows sometimes suggests installing Python from the Store. Don't. It has sandboxing quirks that break virtual environments. Use python.org only.

## Step 2. Download Constellar

You can either clone the code with Git (the developer way) or just download a ZIP. **For first-timers, ZIP is easier.**

1. Go to the Constellar GitHub page in your browser.
2. Click the green **`Code ▾`** button (top right of the file list).
3. Click **"Download ZIP"** at the bottom of the dropdown.
4. The file `constellar-main.zip` downloads.
5. Move it somewhere stable like `C:\Users\<you>\Documents\`. Right-click → **Extract All**. You'll end up with a folder called `constellar-main` (or just `constellar`).
6. **Remember where this folder is.** You'll keep coming back to it.

## Step 3. Open PowerShell *inside* the Constellar folder

**What is PowerShell?** It's a text-based way to talk to your computer — like a control panel that you type commands into. Don't be intimidated; you'll only run a handful of commands and you can copy-paste all of them.

1. Open File Explorer and navigate into the `constellar-main` folder. You should see files like `app.py`, `README.md`, etc.
2. **Hold Shift** and right-click on empty space inside the folder.
3. Click **"Open PowerShell window here"** (Windows 10) or **"Open in Terminal"** (Windows 11).
4. A blue or black window opens. The first line will say something like `PS C:\Users\you\Documents\constellar-main>`.

That `PS C:\...>` is the prompt. Everything you type goes there.

## Step 4. Tell Windows it's OK to run scripts

By default Windows blocks Python's helper scripts from running. You only need to fix this once per computer.

Paste this into the PowerShell window and press Enter:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

It'll ask "Do you want to change the execution policy?" Type **`Y`** and press Enter.

(Nothing visible happens — that's fine. You're done with this step.)

## Step 5. Create a virtual environment

**What is a virtual environment?** It's a private little Python world just for Constellar. Without it, the libraries Constellar needs would get mixed in with every other Python project on your machine and cause problems. The virtual environment keeps everything tidy.

In the same PowerShell window, paste this and press Enter:

```powershell
python -m venv .venv
```

Takes about 10 seconds. Nothing dramatic happens — there's no progress bar — but you'll see a new folder called `.venv` appear inside `constellar-main`.

## Step 6. Activate the virtual environment

Paste this and press Enter:

```powershell
. .venv\Scripts\Activate.ps1
```

(The leading dot, then a space, then the path — yes, the dot matters.)

You'll know it worked because your prompt now starts with **`(.venv)`** before the `PS C:\...`. Like:

```
(.venv) PS C:\Users\you\Documents\constellar-main>
```

That `(.venv)` is your signal that you're "inside" the virtual environment. From now on whenever you open PowerShell to run Constellar, you'll need to run this same command first.

## Step 7. Install Constellar's dependencies

**What are dependencies?** They're other people's code that Constellar uses — the embedding model, the math library, the web server, etc. You need to download them all, but only once.

Paste this and press Enter:

```powershell
pip install -r requirements.txt
```

This takes **2–5 minutes** and downloads about 500 MB. You'll see lots of "Collecting xyz... Downloading xyz..." text scroll by. That's normal. Wait for it to finish — you'll know it's done when you see your prompt again.

If pip prints `Successfully installed ...` at the end, you're golden.

## Step 8. Launch Constellar

Paste one of these:

- **Tray icon mode (recommended):** `pyw app.py --tray`
  - Constellar runs in the background. Look in your system tray (bottom-right of the taskbar, the little arrow that hides icons) — there's a star icon. Click it → "Open Constellar" → your browser opens to the app.
- **Browser mode:** `python app.py --web`
  - PowerShell stays open showing logs. Open <http://127.0.0.1:5173> manually in your browser.

You should see the Constellar interface. The list view will be empty at first — that's expected; the first refresh fires automatically on launch and downloads a small AI model (~80 MB), which takes about 30 seconds. After that, items start filling in.

> **Tip:** double-click `Setup-Shortcuts.vbs` once to install a desktop shortcut + Start Menu entry. After that you can launch Constellar without ever touching PowerShell again.

## Step 9. Verify it works

After about a minute:

- The list view should fill with news items and Reddit posts.
- Click the **constellation** button in the top bar — you'll see a star-field with coloured dots.
- Click a card — it opens the article in a new tab.

If that's all working: **the basic version is set up.** You can stop here and use Constellar as a non-AI feed reader, or continue to Part 2 to turn on the smart features.

---

# Part 2 — Turn on the AI features

This part adds:

- **Per-item AI takes** — every news item gets a one-line opinion written by Claude (the AI by Anthropic).
- **Smart sorting** — the AI scores items 0–1 by how much you'd care, and the list sorts by that.
- **Cluster names with personality** — instead of "Cluster 4", you get "Kohlra" and "Vereth".
- **A learned taste profile** — the AI watches what you click and reject and gets better over time.

This costs real money — but not much. Plan on $2–10 USD/month depending on how many feeds you have. Anthropic gives you free credits when you sign up so you can try it without paying.

You can also turn on the **Reddit credentials** which give you better Reddit results (vote counts, full content, more items per subreddit). Reddit's API is free — you just need to register a "script app", which takes about 3 minutes.

## Step 10. Sign up for Anthropic

1. Go to **<https://console.anthropic.com/>**.
2. Click **Sign up** (or Sign in if you already have an account).
3. Fill in email, verify it. You may need to add a phone number.
4. The first time you log in, you'll get **$5 in free credits** automatically. That's enough to play with.

## Step 11. Get an Anthropic API key

**What's an API key?** Think of it as a password that lets *programs* (not you) log in on your behalf. You give the key to Constellar; Constellar uses it to ask Claude for takes.

1. Once logged in to the Anthropic Console, look at the left sidebar for **Settings** (gear icon) → **API Keys**. Or go directly to **<https://console.anthropic.com/settings/keys>**.
2. Click **+ Create Key**.
3. Name it something like `constellar` so you can remember what it's for later.
4. **The key appears once and once only.** It starts with `sk-ant-` and is very long. **Copy it immediately** to your clipboard. If you lose it you have to make a new one — that's fine, just remember.

## Step 12. Make Constellar's config file

Constellar reads API keys from a special file that lives **outside** the project folder (so it can't accidentally end up on GitHub).

1. Open PowerShell (any window, doesn't have to be the Constellar one). Paste:

   ```powershell
   mkdir $HOME\.constellar
   ```
   
   Don't worry if it says "already exists" — that's fine.

2. Now copy the template file into it:

   ```powershell
   copy <path-to-constellar>\config.env.example $HOME\.constellar\config.env
   ```
   
   Where `<path-to-constellar>` is the folder you extracted earlier, e.g. `C:\Users\you\Documents\constellar-main`. So the full command might look like:
   
   ```powershell
   copy C:\Users\you\Documents\constellar-main\config.env.example $HOME\.constellar\config.env
   ```

3. Open the new file in Notepad:

   ```powershell
   notepad $HOME\.constellar\config.env
   ```

   Notepad opens with a bunch of commented-out keys.

## Step 13. Paste your Anthropic key into the config

In Notepad, find the line that says:

```
ANTHROPIC_API_KEY=
```

Click after the `=` sign and paste your key. The line should now look like:

```
ANTHROPIC_API_KEY=sk-ant-api03-abcd1234...verylong...xyz
```

No spaces around the `=`. No quotes around the value.

Save the file: **File → Save** (or Ctrl+S). Close Notepad.

## Step 14. Optional — get Reddit credentials

Skip this section if you only care about the news feeds. If you want better Reddit data (vote counts, full content, more items per sub), do this 3-minute setup.

1. Go to **<https://www.reddit.com/prefs/apps>**. Log into your Reddit account if it asks.
2. Scroll to the bottom. Click **"are you a developer? create an app..."** (or **"create another app..."** if you already have one).
3. A form appears. Fill it in:
   - **name**: `constellar`
   - **App type**: tick **script** (this is important).
   - **description**: leave blank.
   - **about url**: leave blank.
   - **redirect uri**: put `http://localhost:8080` (it's required but not actually used).
4. Click **create app**.
5. The new app appears on the page. You need two values from it:
   - The **client ID** — a short string of letters and numbers right *underneath* the name "personal use script". It's small and easy to miss.
   - The **secret** — labelled "secret". Longer string.
6. Open your config file again with `notepad $HOME\.constellar\config.env`. Find these lines and paste your values:

   ```
   REDDIT_CLIENT_ID=your-short-id-here
   REDDIT_CLIENT_SECRET=your-longer-secret-here
   ```
   
   Save and close.

> The `REDDIT_USERNAME` and `REDDIT_PASSWORD` lines are even more optional — only fill them in if you want your *personalised* Reddit frontpage instead of the public r/popular. **Warning**: this means putting your Reddit password in a text file, which is fine for personal use but you should be aware of it. If you have 2FA on your Reddit account, this won't work — Constellar can't do 2FA — so skip it.

## Step 15. Restart Constellar

The config file is only read when Constellar starts. If it's currently running, quit it first:

- If you used **tray mode**: right-click the tray icon → Quit.
- If you used **browser mode**: go back to your PowerShell window and press **Ctrl+C**.

Then re-launch using the same command as before:

```powershell
pyw app.py --tray
```

(Remember to activate the virtual environment first if it's not already active — your prompt should show `(.venv)`. If not, run `. .venv\Scripts\Activate.ps1`.)

## Step 16. Verify the AI is working

Open Constellar in the browser. Hit the **refresh** button in the top-right.

You should see the refresh progress bar walk through stages: *fetching*, *embedding*, *mapping*, *scoring*, **asking Claude...** ← this is the new one. If you see "asking Claude...", the API key is working.

After it finishes:

- Items in the list view now have **AI takes** — a short italic comment under each title.
- The top 3 items get **featured-card** treatment with the take rendered as a pull-quote.
- On the constellation view, clusters now have **proper names** (like "Vereth" or "Kohlra") rather than `cluster 12 · 8`.

If you don't see takes after the refresh, check your config file again — most likely the key has a typo or got pasted with spaces around the `=`.

---

# Troubleshooting

**`'python' is not recognized as a command`** — Python's PATH checkbox got missed during install. Uninstall Python, reinstall, tick the box this time.

**`. : File ... Activate.ps1 cannot be loaded because running scripts is disabled`** — you skipped Step 4. Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, answer `Y`.

**`pip` takes forever or fails** — your antivirus might be scanning every download. Temporarily disable it or whitelist the `.venv` folder, then retry.

**Tray icon doesn't appear** — Windows hides infrequently-used icons. Click the little **^** arrow in the system tray to see hidden ones. The Constellar star should be there. Right-click and drag it out to pin.

**Browser shows "can't reach this site"** — Constellar takes a few seconds to start. Wait 10 seconds and refresh. If still nothing, check the PowerShell window for error messages.

**The refresh never finishes** — most likely network issue. Check the PowerShell window for error lines starting with `[constellar]`. RSS feeds occasionally go down; one bad source shouldn't break the whole refresh, but a flaky internet connection will.

**The first refresh takes forever** — the *first* one downloads an 80 MB AI model. After that, refreshes are seconds. Don't panic if it sits at "embedding new items…" for a minute the first time.

**Logs (if you launched with tray mode)** — `%USERPROFILE%\.constellar\constellar.log`. Open it with Notepad to see what Constellar is doing.

---

# Daily use, after setup

Once everything is set up, your daily flow is:

1. Click the desktop shortcut (or the tray icon → Open Constellar).
2. Constellar auto-refreshes if data is more than 30 minutes old.
3. Click items you want to read. Dismiss the ones you've handled. Reject the ones the AI shouldn't have shown you.

That's it. No commands, no PowerShell, no remembering to do anything. The AI quietly improves week over week as it learns from your clicks.

For more advanced stuff — editing your feed list, retuning the curves, etc. — see `INSTRUCTIONS.md`.
