# NoteVerse

A full-stack note management web application built with Node.js, Express, SQLite, WebSocket, and Progressive Web App technologies.

## Features

- User registration, activation, login, logout, and password reset
- Profile and avatar management
- User preferences
- Create, edit, delete, pin, search, and filter notes
- List and grid note views
- Labels and label-based filtering
- Image attachments
- Password-protected notes
- Note sharing with read-only or edit permissions
- Realtime collaboration using WebSocket
- Offline note viewing and queued edits
- Progressive Web App support
- SQLite persistence
- Docker Compose deployment
- MailHog integration for local email testing

## Tech Stack

- Node.js
- Express
- SQLite with better-sqlite3
- WebSocket (`ws`)
- Vanilla JavaScript
- HTML/CSS
- Progressive Web App APIs
- Docker
- Docker Compose
- MailHog

## Project Structure

```text
NoteVerse/
├── README.md
├── .gitignore
└── src/
    ├── docker-compose.yml
    └── app/
        ├── Dockerfile
        ├── package.json
        ├── server.js
        ├── data/
        ├── uploads/
        └── public/
            ├── index.html
            ├── app.js
            ├── styles.css
            ├── service-worker.js
            ├── manifest.webmanifest
            ├── reset.html
            └── icon.svg
```

## Run with Docker Compose

### Requirements

- Docker Desktop on Windows
- Docker Engine and Docker Compose on Linux/macOS

### Start

Open a terminal in the `src` directory:

```bash
docker compose up --build
```

Open:

```text
http://localhost:8080
```

MailHog:

```text
http://localhost:8025
```

## Demo Accounts

| Role | Email | Password |
|---|---|---|
| Owner | alice@example.com | 123456 |
| Editor | bob@example.com | 123456 |
| Reader | cara@example.com | 123456 |

Protected demo note password:

```text
note123
```

These credentials are for local demonstration only.

## Realtime Collaboration

Shared editable notes use WebSocket communication.

1. Log in as Alice in one browser.
2. Log in as Bob in another browser.
3. Open the shared editable note.
4. Edit the note from either browser.
5. Observe realtime synchronization.

Read-only shared notes disable editing controls.

## Offline Support

The application includes:

- Service Worker caching
- Local note caching
- Offline note viewing
- Queued title/content edits
- Synchronization after the connection returns

## Security

The application includes:

- Password hashing with bcrypt
- HTTP-only session cookies
- Helmet security headers
- Password-protected notes
- Server-side authentication and authorization
- Permission checks for shared notes

The default configuration is intended for local development and demonstration. Production deployment should use a strong session secret, HTTPS, secure cookie settings, and production-grade infrastructure.

## Development

From `src/app`:

```bash
npm install
npm start
```

The default application port is:

```text
8080
```

## Demo Video

https://youtu.be/dIJIwwbXEis

## License

This project was developed as an academic final project. Check the repository for applicable third-party license information.
