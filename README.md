# Omni Inspection Finder

Upload the **I&T Master** export from Microsoft Lists and see every inspection on
a map with its company name, address and due date, plus what else is due nearby.

**Live:** https://omni-technologies.github.io/omni-inspection-finder/

## Using it

1. In Microsoft Lists, export the I&T Master list to CSV.
2. Open the site and click **Upload CSV** (or drop the file anywhere on the page).
   The first upload in a browser takes about a minute while addresses are located.
   After that, pins load instantly, and a new export only looks up new addresses.
3. Find inspections either way:
   - **Map:** zoom in and labels appear with the company name and due date,
     colour-coded by urgency. When an address has more than one inspection
     (say an annual and a semi-annual), the label shows every due date,
     soonest first, and the pin takes the soonest one's colour. Crowded labels
     shrink to just the dates or a dot, so zoom in further or hover a pin to
     see it.
   - **Search:** type a company, client, address or project number (press `/`
     to jump to the search box). Picking a result flies to it and lists every
     other inspection within the chosen radius, nearest first, with due dates
     and distances. **Copy list** puts that list on the clipboard.
4. The side list shows everything in the current map view, earliest due first.
   Already-scheduled work comes after unscheduled work.

| Colour | Meaning |
|---|---|
| Red | Due date has passed |
| Orange | Due within 30 days |
| Yellow | Due in 31–90 days |
| Green | Due later |
| Blue ✓ | Progress says scheduled (or a Scheduled Date is set) |

The due filters (Past due, ≤ 30 days, …) include past-due inspections, because
those are due too. **Hide scheduled** removes work that is already booked.

### Pins that need a hand

A few addresses can't be matched to an exact building. Those pins have a dashed
outline and an "Approximate pin" note. Open one, click **Move pin**, then click
the right spot on the map. Hand-placed pins are remembered in that browser.

## Privacy

- The CSV is read **in your browser** and saved only in that browser's local
  storage, so the page reopens with your data. **Clear saved data** removes it.
- This repository is public and contains **no customer data**. Never commit a
  CSV; `.gitignore` blocks `*.csv`.
- To place pins, the street address (and nothing else) is sent to the free
  [US Census Geocoder](https://geocoding.geo.census.gov/), falling back to
  [OpenStreetMap Nominatim](https://nominatim.org/). Map tiles come from
  OpenStreetMap.

## Development

Requires Node 20+.

```sh
npm install
npm run dev        # http://127.0.0.1:5230
npm test           # unit tests (synthetic data only)
npm run typecheck
npm run build      # production build in dist/
```

Pushing to `main` builds, tests and deploys to GitHub Pages
(`.github/workflows/deploy.yml`).

Stack: React 19, TypeScript, Vite, Leaflet. No server, no API keys.

Expected CSV columns (matched case-insensitively): `Title`, `Due date` and
`Address` are required. `Client Name`, `Progress`, `Scheduled Date`,
`Scheduled?`, `Frequency`, `System Type`, `Current Project Number`,
`Quoted Hours`, `# of Techs Required`, `Preferred Inspector`, `Panel Type`,
`Date of Last Inspection Completed`, `Contract End Date/Re-Quote`, `Notes`,
`Contact Name & Number` and `Contact (s) Email` are shown when present.
