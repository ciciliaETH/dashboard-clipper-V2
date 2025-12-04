# Quick Start - Clipper Analytics Dashboard

Panduan cepat untuk mulai menggunakan Clipper Dashboard.

## ⚡ 3-Menit Setup

### 1. Siapkan Credentials dari Supabase
- Go ke https://supabase.com - create project
- Copy 3 keys dari Settings > API:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`

### 2. Setup Database
- Di Supabase SQL Editor, jalankan SQL dari `SETUP_GUIDE.md` (Section 2, Step 4)
- Ini akan create tables + test users

### 3. Konfigurasi Project
```bash
# Buka project folder
cd c:\Users\USER\Downloads\dashboard-clipper

# Edit .env.local
# Paste credentials dari Supabase

# Install & run
npm install
npm run dev
```

### 4. Login & Test
- Go to http://localhost:3000/login
- Email: `admin@example.com`
- Password: `Admin123!`

---

## 📍 URLs & Pages

| Page | URL | Akses |
|------|-----|-------|
| Homepage | http://localhost:3000 | Public |
| Login | http://localhost:3000/login | Public |
| Sign Up | http://localhost:3000/signup | Public |
| Dashboard | http://localhost:3000/dashboard | Logged in users |
| Admin Panel | http://localhost:3000/dashboard/admin | Admin only |

---

## 👥 Test Accounts

Setelah setup, gunakan account ini untuk test:

**Admin Account:**
```
Email: admin@example.com
Password: Admin123!
```

**Karyawan Account:**
```
Email: karyawan@example.com
Password: Karyawan123!
```

---

## 🎯 Fitur Per Role

### Admin
- ✅ CRUD Users
- ✅ View all analytics
- ✅ Manage dashboard

### Karyawan
- ✅ View own analytics
- ✅ See TikTok metrics

### Public User
- ✅ Search analytics
- ✅ View public data

---

## 🚀 Development Commands

```bash
# Start dev server
npm run dev

# Build for production
npm run build

# Run production build
npm start

# Run linting
npm run lint
```

---

## 📦 Project Structure

```
src/
├── app/              # Next.js app routes
├── lib/              # Utilities & config
├── types/            # TypeScript definitions
└── components/       # React components
```

---

## 🔧 Tech Stack

- **Frontend**: Next.js 15 + React 19 + TypeScript
- **Styling**: Tailwind CSS
- **Database**: Supabase (PostgreSQL)
- **Auth**: Supabase Auth
- **Icons**: React Icons
- **UI Components**: Custom Tailwind components

---

## 📋 Checklist Setup

- [ ] Create Supabase project
- [ ] Copy Supabase credentials
- [ ] Setup database schema
- [ ] Create test users
- [ ] Configure .env.local
- [ ] Run `npm install`
- [ ] Run `npm run dev`
- [ ] Test login with admin account
- [ ] Explore dashboard

---

## ❓ Common Issues

**Issue**: "Invalid supabaseUrl"
- Solution: Check `.env.local`, format should be `https://xxx.supabase.co`

**Issue**: Can't login
- Solution: Make sure test users were created (run SQL from SETUP_GUIDE.md)

**Issue**: No metrics showing
- Solution: Test user should have sample data, check if it's there in Supabase

**Issue**: "Permission denied" errors
- Solution: Check RLS policies in Supabase, make sure they're enabled

---

## 📚 Next Steps

1. **Read Full Setup Guide** → `SETUP_GUIDE.md`
2. **Read README** → `README.md`
3. **Integrate Real APIs** → Configure TikTok API (RapidAPI)
4. **Deploy** → Deploy to Vercel, Netlify, etc.

---

## 🎨 Customization

Edit these files untuk custom:

- `src/app/globals.css` - Change colors/fonts
- `src/components/` - Custom components
- `tailwind.config.ts` - Tailwind config

---

**Happy coding! 🎉**
