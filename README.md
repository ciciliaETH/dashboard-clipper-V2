# Clipper Analytics Dashboard

Dashboard analytics modern untuk menampilkan metrics real-time dari TikTok dengan sistem role-based access control.

## Features

- 📊 **Real-time Analytics**: Monitor metrics terbaru dari TikTok
- 👥 **Team Management**: Kelola tim dengan 3 role berbeda (Admin, Karyawan, Umum)
- 🔐 **Secure Authentication**: Powered by Supabase dengan auth system yang aman
- 🎨 **Modern UI**: Clean, modern design dengan color scheme biru (#2A62FF)
- 📱 **Responsive**: Fully responsive design untuk semua device

## Roles

### Admin
- CRUD management untuk semua users
- Tambah, edit, dan hapus user
- Akses ke admin dashboard

### Karyawan
- Lihat analytics TikTok khusus akun mereka
- Tidak bisa akses data user lain

### Umum
- Lihat analytics dari public username
- Bisa mencari analytics berdasarkan username
- Akses read-only

## Setup

### Prerequisites
- Node.js 18+
- npm or yarn
- Supabase account

### Installation

1. Install dependencies
```bash
npm install
```

2. Setup environment variables
```bash
cp .env.local.example .env.local
```

Edit `.env.local` dengan credentials Supabase Anda:
```
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
RAPIDAPI_KEY=your_rapidapi_key
RAPIDAPI_TIKTOK_HOST=tiktok-api23.p.rapidapi.com
```

3. Setup database di Supabase

Run migration di Supabase SQL editor:
```sql
-- Create users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT auth.uid(),
  email TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'umum',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create social_metrics table
CREATE TABLE social_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  username TEXT NOT NULL,
  likes INTEGER DEFAULT 0,
  views INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  saves INTEGER DEFAULT 0,
  video_title TEXT,
  video_url TEXT,
  video_posted_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes
CREATE INDEX idx_social_metrics_user_id ON social_metrics(user_id);
CREATE INDEX idx_social_metrics_platform ON social_metrics(platform);
CREATE INDEX idx_social_metrics_video_posted_at ON social_metrics(video_posted_at DESC);

-- Setup RLS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_metrics ENABLE ROW LEVEL SECURITY;
```

4. Run development server
```bash
npm run dev
```

Buka [http://localhost:3000](http://localhost:3000) di browser Anda.

## Project Structure

```
src/
├── app/
│   ├── page.tsx           # Homepage
│   ├── login/
│   ├── signup/
│   ├── dashboard/
│   │   ├── page.tsx       # Main dashboard
│   │   ├── layout.tsx     # Dashboard layout
│   │   └── admin/
│   │       └── page.tsx   # Admin user management
│   └── api/               # API routes
├── components/            # React components
├── lib/
│   └── supabase/         # Supabase client config
├── types/                # TypeScript types
└── styles/               # Global styles
```

## Available Pages

- `/` - Homepage
- `/login` - Login page
- `/signup` - Sign up page
- `/dashboard` - Main analytics dashboard
- `/dashboard/admin` - Admin user management (Admin only)

## Environment Variables

```
NEXT_PUBLIC_SUPABASE_URL       # Supabase project URL
NEXT_PUBLIC_SUPABASE_ANON_KEY  # Supabase anonymous key
SUPABASE_SERVICE_ROLE_KEY      # Supabase service role key (for admin operations)
```

## Tech Stack

- **Framework**: Next.js 15 dengan TypeScript
- **UI**: React + Tailwind CSS
- **Database**: Supabase (PostgreSQL)
- **Authentication**: Supabase Auth
- **Icons**: React Icons (Feather + Font Awesome)
- **Date Handling**: date-fns
- **HTTP Client**: Axios
- **Validation**: Zod

## Deployment

### Deploy ke Vercel

```bash
npm run build
vercel deploy
```

Pastikan environment variables sudah di-set di Vercel dashboard.

## License

MIT

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
