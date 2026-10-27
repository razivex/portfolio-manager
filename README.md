# Portfolio

One list of US stocks, US REITs, US ETFs, Brazilian stocks, Brazilian FIIs, Brazilian ETFs, and crypto.

Open `index.html` in the browser. Nothing else has to be running.

GitHub Pages can publish the same files. The workflow is `.github/workflows/pages.yml`. In the repository, set Settings → Pages → Build and deployment → Source to GitHub Actions. The site is then published on each push to `main`.

The page asks for prices only when you search, and again about every 15 seconds while the list is on screen. It pauses when the tab is hidden. Prices are converted into the currency selected in Settings (BRL, USD, or EUR). Each asset has an amount field with up to 8 decimal places. The row shows that unit price between the name and the position, which is the amount times the price in the selected currency. The list is stored in the browser only. The first visit shows **Add asset**. Later visits open that same list.
