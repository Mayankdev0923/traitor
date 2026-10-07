# Traitors Role Dealer 🗡️

A fast, secret companion app for the social-deduction party game **"The Traitors"** (Mafia/Werewolf style). One person hosts on a laptop or tablet, players join on their phones, and the app secretly deals each player their role.

---

## Features
- **Secret Role Dealing**: Server-enforced role secrecy. Players only see their own role.
- **Auto Role Wipe (`ack`)**: Once a player confirms *"I've seen it. Hide"*, their role is immediately deleted from server memory/Redis storage.
- **Brutalist Neon Mint Design**: High-contrast `#F1F3EC` bone background with faint 32px grid, `#000` 3px thick borders, hard 6px offset shadows, and `#39FFB4` neon mint accents.
- **Slot Machine Reveal Animation**: Cyclic slot-machine icons before popping the real role.
- **Live Host Roster & Confirmed Tracker**: Host sees real-time player counts and checkmarks when players confirm their role.
- **Multiple Simultaneous Games**: Isolated 4-character codes (no look-alikes like 0/O/1/I/L).
- **Session Persistence**: Page reloads preserve your session in `localStorage`.

---

## Tech Stack
- **Frontend**: React 18, Vite, Framer Motion, Lucide React, Canvas Confetti.
- **Backend API**: Vercel Serverless Function (`/api/game.js`, Node.js ESM).
- **Database**: Upstash Redis via REST pipeline (or Vercel KV REST API).
- **Crypto**: Cryptographically sound Fisher-Yates shuffle using Node `crypto.randomInt`.

---

## Local Development

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Run local dev server**:
   ```bash
   npm run dev
   ```
   Open `http://localhost:5173` in your browser. The Vite dev server includes an embedded dev proxy for `/api/game`.

3. **Run API verification tests**:
   ```bash
   npm test
   ```
   This executes `test/test-api.js` verifying isolated games, secret role dealing, `ack` deletion, and reshuffle behavior.

4. **Test via Vercel CLI** (Optional):
   ```bash
   vercel dev
   ```

---

## Deployment to Vercel

1. **Push code to GitHub/GitLab**:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin <your-repo-url>
   git push -u origin main
   ```

2. **Import into Vercel**:
   - Log in to your [Vercel Dashboard](https://vercel.com).
   - Click **Add New...** -> **Project** and import your repository.
   - Build command: `npm run build`, Output directory: `dist`.

3. **Add Upstash Redis Storage**:
   - In your Vercel Project Dashboard, navigate to the **Storage** tab.
   - Click **Create Database** -> select **Upstash Redis** (or **Vercel KV**).
   - Link the database to your project. Vercel automatically populates `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_URL` and `KV_REST_API_TOKEN`).

4. **Redeploy**:
   - Click **Redeploy** on Vercel so the serverless function picks up the environment variables.

---

## Security & Secrecy Architecture

- **Server-Side Secrecy**: The `/api/game` handler never returns other players' roles to any client.
- **Host Isolation**: The host receives player names and acknowledgment statuses (`x/y confirmed`), but never player roles.
- **Role Purging**: When a player acknowledges their role (`action: 'ack'`), the `HDEL` command deletes the role entry from Redis so subsequent state calls return `role: null`.
- **Game TTL**: All Redis game keys expire after 24 hours of inactivity.
