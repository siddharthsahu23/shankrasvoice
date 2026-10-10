# Shankra ki Awazz
Raise a campus issue safely, watch it get resolved. Hacktoberfest · Team shankara_ke_cheetehe

## Run
Needs Node 22.5+ (uses built-in `node:sqlite`, no `npm install`).

    ADMIN_PASSWORD=yourpass npm start
    # open http://localhost:3000   (admin: /admin.html)

## Features
- Anonymous-by-default reports; author is never stored unless the student opts in
- Auto-routing by category to the right team
- Tracking code (SKA-XXXXXX) + public status timeline
- Upvotes (one per browser), search, filters, live stats
- Admin dashboard to change status and post public notes

## API
GET  /api/meta · /api/stats · /api/issues?category=&status=&search=&sort=votes
POST /api/issues · /api/issues/:code/upvote
GET  /api/issues/:code
POST /api/admin/login · PATCH /api/admin/issues/:code  (Bearer token)

## Next steps
Swap the in-memory admin session for JWT, add per-team logins, email/SMS status alerts, image attachments.
