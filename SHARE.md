# Share with a friend (private + auto-updates)

Source stays **private** on GitHub. Your friend gets updates **automatically every time they open the app** (the launcher runs `git pull` first).

> True “just open a website link” hosting from a *private* repo needs Cloudflare Pages / Netlify (one-time setup). This git-launcher approach needs no paid plan and no extra accounts.

## One-time setup (you)

```bash
# Already done if the private repo exists and code is pushed.
# Invite your friend (GitHub username):
gh api -X PUT repos/OWNER/REPO/collaborators/THEIR_USERNAME -f permission=pull
```

Or: GitHub → repo → **Settings → Collaborators → Add people**.

## One-time setup (your friend, Windows)

1. Create a free [GitHub](https://github.com) account and accept your invite.
2. Install:
   - [Git for Windows](https://git-scm.com/download/win)
   - [Python](https://www.python.org/downloads/) **or** [Node.js](https://nodejs.org/)  
     (either one is enough; Python is fine)
3. Open **Git Bash** or PowerShell and clone (use the real repo URL):

   ```bash
   git clone https://github.com/OWNER/REPO.git
   cd REPO
   ```

4. Double-click **`launch-windows.bat`** inside that folder.

5. Optional: right-click `launch-windows.bat` → **Send to → Desktop (create shortcut)**.

Their wheel configs (sections, images, sound) stay in **their browser** (`localStorage`). Updates only replace the app code, not their saves.

## Every time after that (friend)

Double-click **`launch-windows.bat`** (or the desktop shortcut).

It will:

1. `git pull` the latest from GitHub  
2. Open the app in the browser  

## You make a change

```bash
cd /path/to/spin-wheel
git add -A
git commit -m "describe change"
git push
```

Next time your friend launches, they get it.

## Optional: real website URL (still private source)

If you want a link like `https://sad-wheel.pages.dev` with no Git on their PC:

1. Create a free [Cloudflare](https://dash.cloudflare.com) account  
2. **Workers & Pages → Create → Pages → Connect to Git**  
3. Pick this private repo → build command empty, output directory `/`  
4. Every `git push` redeploys; send them only that URL  

Source stays private; the live site URL is secret unless you share it.
