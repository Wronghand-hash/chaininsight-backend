# API Documentation: User Profile

## Get Current User Profile

### Endpoint
```
GET /scanner/api/v1/kol/me
```

### Description
Retrieves the profile information of the currently authenticated user. This endpoint requires a valid Google OAuth access token to be present in the request cookies.

### Authentication
- **Required**: Google OAuth Authentication
- **Cookies**:
  - `google_access_token`: The Google OAuth access token (required)
  - `google_refresh_token`: The Google OAuth refresh token (optional, used for token refresh)

### Request Headers
```http
Cookie: google_access_token=<your_access_token>; google_refresh_token=<your_refresh_token>
```

## Response

### Success Response (200 OK)
Returns the user's profile information.

```json
{
  "username": "johndoe",
  "email": "johndoe@example.com",
  "verified": true,
  "created_at": "2025-11-23T08:30:00.000Z",
  "updated_at": "2025-11-23T10:15:00.000Z",
  "twitter_addresses": ["twitter1", "twitter2"],
  "google_id": "1234567890",
  "name": "John Doe",
  "picture": "https://example.com/profile.jpg",
  "access_token": "ya29.a0ARrda...",
  "refresh_token": "1//03g...",
  "token_expiry": "2025-11-23T11:15:00.000Z",
  "last_login_at": "2025-11-23T10:15:00.000Z",
  "login_count": 5,
  "locale": "en-US",
  "hd": "example.com",
  "auth_provider": "google",
  "current_sign_in_ip": "192.168.1.1",
  "last_sign_in_ip": "192.168.1.1",
  "sign_in_count": 10,
  "tos_accepted_at": "2025-11-23T08:30:00.000Z",
  "email_verified": true
}
```

### Error Responses

#### 400 Bad Request
- Invalid token format or missing required fields
```json
{
  "error": "Invalid token: No email found"
}
```

#### 401 Unauthorized
- Missing or invalid access token
```json
{
  "error": "No access token provided"
}
```

#### 404 Not Found
- User not found in the database
```json
{
  "error": "User not found"
}
```

#### 500 Internal Server Error
- Server-side error occurred
```json
{
  "error": "Internal server error"
}
```

## Notes
1. The endpoint automatically handles token refresh if the access token is expired and a refresh token is provided.
2. The `access_token` and `refresh_token` in the response are only included if the user has the necessary permissions.
3. The `twitter_addresses` field contains an array of Twitter usernames associated with the account.
4. The `email_verified` field indicates whether the user's email has been verified with Google.

## Example Usage

### cURL
```bash
curl -X GET 'http://localhost:3000/scanner/api/v1/kol/me' \
  -H 'Cookie: google_access_token=ya29.a0ARrda...; google_refresh_token=1//03g...'
```

### JavaScript (Fetch API)
```javascript
const response = await fetch('http://localhost:3000/scanner/api/v1/kol/me', {
  method: 'GET',
  credentials: 'include'  // Important for sending cookies
});

if (response.ok) {
  const userData = await response.json();
  console.log('User profile:', userData);
} else {
  const error = await response.json();
  console.error('Error:', error);
}
```

### Axios
```javascript
import axios from 'axios';

const response = await axios.get('http://localhost:3000/scanner/api/v1/kol/me', {
  withCredentials: true  // Important for sending cookies
});

console.log('User profile:', response.data);
```

## Response Fields

| Field | Type | Description |
|-------|------|-------------|
| username | string | The user's username (derived from email) |
| email | string | The user's email address |
| verified | boolean | Whether the user's account is verified |
| created_at | string (ISO 8601) | When the user account was created |
| updated_at | string (ISO 8601) | When the user account was last updated |
| twitter_addresses | string[] | Array of Twitter usernames |
| google_id | string | The user's Google ID |
| name | string | The user's full name |
| picture | string | URL to the user's profile picture |
| access_token | string | Google OAuth access token (if available) |
| refresh_token | string | Google OAuth refresh token (if available) |
| token_expiry | string (ISO 8601) | When the access token expires |
| last_login_at | string (ISO 8601) | When the user last logged in |
| login_count | number | Number of times the user has logged in |
| locale | string | User's preferred locale |
| hd | string | The hosted domain of the user's G Suite account |
| auth_provider | string | Authentication provider (e.g., 'google') |
| current_sign_in_ip | string | Current sign-in IP address |
| last_sign_in_ip | string | Previous sign-in IP address |
| sign_in_count | number | Number of sign-ins |
| tos_accepted_at | string (ISO 8601) | When the user accepted the Terms of Service |
| email_verified | boolean | Whether the user's email is verified |
