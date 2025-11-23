# Integrating Google Sign-In and Payment Flows in Next.js Frontend

This README provides step-by-step guidance for integrating Google Sign-In with the backend (Express.js API) and handling authenticated requests for payment initialization (`generateWalletKeypair`) and status checking (`getPaymentStatus`). The backend handles the full OAuth2 flow, sets secure HttpOnly cookies for session management, and validates them on protected routes. Your Next.js frontend will initiate the auth flow via redirects and make cross-origin requests with credentials to include cookies.

## Prerequisites

- Next.js 13+ (App Router recommended).
- Backend API running on a different domain/port for testing (e.g., `http://localhost:3001`).
- Google OAuth2 credentials configured in backend env vars (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).
- Install dependencies:
  ```bash
  npm install next react react-dom
  # Optional: for query params handling
  npm install next/router
  ```

## 1. Google Sign-In Integration

The backend manages the OAuth2 flow. Your frontend initiates it by redirecting to the backend's `/auth/google` endpoint. After auth, Google redirects back to the backend's `/auth/google/callback`, which sets cookies and redirects to your frontend's `/dashboard` with user info in query params.

### Step 1: Create a Sign-In Button

In your login page (e.g., `app/login/page.tsx` or `pages/login.tsx`):

```tsx
"use client"; // If using App Router

import { useRouter } from "next/navigation"; // Or next/router for Pages Router

export default function LoginPage() {
  const router = useRouter();
  const backendUrl =
    process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001"; // Set in .env.local

  const handleGoogleSignIn = () => {
    // Redirect to backend's Google auth init
    window.location.href = `${backendUrl}/auth/google`;
  };

  return (
    <div>
      <h1>Sign In</h1>
      <button onClick={handleGoogleSignIn}>Sign in with Google</button>
    </div>
  );
}
```

- **Env Var**: Add `NEXT_PUBLIC_BACKEND_URL=http://localhost:3001` to `.env.local` (adjust for production).

### Step 2: Handle Post-Auth Redirect

After callback, backend redirects to `/dashboard?email=...&name=...&picture=...` (query params from Google user info).

In `app/dashboard/page.tsx` (or `pages/dashboard.tsx`):

```tsx
"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface UserInfo {
  email: string;
  name: string;
  picture?: string;
}

export default function Dashboard() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [user, setUser] = useState<UserInfo | null>(null);

  useEffect(() => {
    const email = searchParams.get("email");
    const name = searchParams.get("name");
    const picture = searchParams.get("picture");

    if (email && name) {
      setUser({ email, name, picture });
      // Optional: Store in localStorage or context for persistence
      localStorage.setItem("user", JSON.stringify({ email, name, picture }));
    } else {
      // No user info? Redirect to login
      router.push("/login");
    }
  }, [searchParams, router]);

  if (!user) return <div>Loading...</div>;

  return (
    <div>
      <h1>Welcome, {user.name}!</h1>
      <img src={user.picture} alt="Profile" width={100} />
      <p>Email: {user.email}</p>
      {/* Payment buttons here – see Section 2 */}
    </div>
  );
}
```

- **Security Note**: Query params are not secure for sensitive data. Use them only for initial display; fetch full user via `/auth/me` (see below).
- **Persistence**: For SPA navigation, use React Context or Zustand to store user state. On app load, check for cookies by calling `/auth/me`.

### Step 3: Verify/Refresh User Session

To get current user (post-auth or on page load), call backend's `/auth/me`. This checks cookies and returns user data.

```tsx
// utils/api.ts
export async function getCurrentUser() {
  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
  const response = await fetch(`${backendUrl}/auth/me`, {
    method: "GET",
    credentials: "include", // Include cookies
  });

  if (!response.ok) {
    throw new Error("Not authenticated");
  }

  return response.json();
}
```

In `_app.tsx` (Pages Router) or `layout.tsx` (App Router), wrap your app with a provider that fetches user on mount.

For client-side Google ID token verification (alternative to redirects), use backend's `/auth/google/verify` with an ID token from Google's JS SDK:

- Install `@react-oauth/google`.
- Follow [Google's Next.js guide](https://developers.google.com/identity/oauth2/web/guides/quickstart#nextjs) but send `idToken` to `/auth/google/verify` instead of handling it client-side.

## 2. Cookie Handling for Payment Routes

The backend sets **HttpOnly, Secure cookies** after auth:

- `google_access_token`: Short-lived (~1h), used for API validation.
- `google_refresh_token`: Long-lived (7 days), auto-refreshes access token if expired.

Cookies are **cross-domain enabled** for testing:

- `sameSite: 'none'` (allows cross-site requests).
- `secure: false` (works over HTTP; set to `true` in prod with HTTPS).

### How Cookies Work

1. **Set During Auth**: Backend sets cookies in response to `/auth/google/callback`.
2. **Sent Automatically**: Browser includes cookies in subsequent requests to backend **if** you set `credentials: 'include'` in fetch/axios.
3. **Validation**: Payment routes (`/payments/generate` and `/payments/status`) read cookies, validate/refresh tokens with Google, and extract user email (twitterId comes from request body).
4. **Refresh**: If access token expires, backend uses refresh token to get a new one and updates cookies.
5. **Expiration**: On invalid/expired session, backend returns 401 with `redirectToLogin: true` – redirect user to `/login`.

**Important**: Cookies are HttpOnly (inaccessible to JS), so no need to read them in frontend. Just ensure requests include them.

### Step 1: Configure CORS on Backend (Admin Note)

Ensure backend CORS allows credentials:

```js
// In backend (e.g., app.ts)
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000", // Your Next.js domain
    credentials: true,
  })
);
```

### Step 2: Make Authenticated Requests

Use fetch with `credentials: 'include'`. Assume API routes: `POST /payments/generate` and `POST /payments/status`.

#### Payment Init (Generate Wallet)

```tsx
// In dashboard component
const handlePaymentInit = async () => {
  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
  try {
    const response = await fetch(`${backendUrl}/payments/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include", // Sends cookies
      body: JSON.stringify({
        chain: "BSC", // or 'SOL'
        amount: 0.1,
        serviceType: "oneDayPlan",
        wallet: "metamask", // e.g.
        token: "USDT",
        twitter_community: "your-community-id",
        twitterId: "user-twitter-id", // From user state or input
      }),
    });

    if (!response.ok) {
      const data = await response.json();
      if (data.redirectToLogin) {
        router.push("/login");
        return;
      }
      throw new Error(data.error || "Payment init failed");
    }

    const { walletAddress } = await response.json();
    console.log("Wallet Address:", walletAddress);
    // Proceed to payment UI
  } catch (error) {
    console.error("Error:", error);
  }
};
```

#### Payment Status Check

```tsx
// Poll or check on demand
const checkPaymentStatus = async () => {
  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
  try {
    const response = await fetch(`${backendUrl}/payments/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include", // Sends cookies
      body: JSON.stringify({
        chain: "BSC",
        twitterId: "user-twitter-id", // From user state
      }),
    });

    if (!response.ok) {
      const data = await response.json();
      if (data.redirectToLogin) {
        router.push("/login");
        return;
      }
      throw new Error(data.error || "Status check failed");
    }

    const { status, address, transactionId } = await response.json();
    if (status === "COMPLETED") {
      console.log("Payment confirmed!");
    } else {
      console.log("Pending...");
    }
  } catch (error) {
    console.error("Error:", error);
  }
};
```
## Logout
import axios from 'axios';

const logoutUser = async () => {
try {
const response = await axios.post(
'http://your-backend-url/kol/auth/logout',
{},
{
withCredentials: true, // Important for sending cookies
}
);

    console.log('Logout successful:', response.data.message);
    // Handle successful logout
    window.location.href = '/login';

} catch (error) {
console.error('Logout error:', error);
// Handle error
}
};
