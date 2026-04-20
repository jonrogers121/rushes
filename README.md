<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/17edd76f-6c27-49e1-8f78-8c0fec2fa644

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Optional: set `VITE_GOOGLE_SHEETS_SERVER_URL` in `.env.local` to override the upload API base URL. Local development defaults to `http://localhost:3007`; production defaults to `https://google-sheets.onrender.com/`
4. Optional: set `VITE_RUSHES_STORAGE_BUCKET` if you want a bucket other than `stillmotion-studio`
5. Run the app:
   `npm run dev`

## Deployment

If you deploy this app on Netlify or another hostname, add that hostname to Firebase Auth before Google sign-in will work:

1. Open Firebase Console for project `gen-lang-client-0711377142`
2. Go to `Authentication -> Settings -> Authorized domains`
3. Add your deployed domain, for example `my-rushes.netlify.app`

Without this, `signInWithPopup` will fail with `auth/unauthorized-domain`.
