import { FiUser } from 'react-icons/fi';

interface EmployeeAvatarProps {
  profilePictureUrl?: string | null;
  username: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const sizeClasses = {
  xs: 'w-6 h-6 text-xs',
  sm: 'w-8 h-8 text-sm',
  md: 'w-10 h-10 text-base',
  lg: 'w-12 h-12 text-lg',
  xl: 'w-16 h-16 text-2xl',
};

export default function EmployeeAvatar({ 
  profilePictureUrl, 
  username, 
  size = 'md',
  className = ''
}: EmployeeAvatarProps) {
  const sizeClass = sizeClasses[size];
  
  // Get initials from username (max 2 characters)
  const getInitials = (name: string) => {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  };

  // Generate consistent gradient based on username
  const getGradient = (name: string) => {
    const colors = [
      'from-blue-500 to-cyan-500',
      'from-purple-500 to-pink-500',
      'from-orange-500 to-red-500',
      'from-green-500 to-teal-500',
      'from-indigo-500 to-purple-500',
      'from-pink-500 to-rose-500',
      'from-yellow-500 to-orange-500',
      'from-teal-500 to-blue-500',
    ];
    
    const hash = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return colors[hash % colors.length];
  };

  if (profilePictureUrl) {
    return (
      <div className={`${sizeClass} rounded-full overflow-hidden border-2 border-white/20 flex-shrink-0 ${className}`}>
        <img 
          src={profilePictureUrl} 
          alt={username}
          className="w-full h-full object-cover"
          onError={(e) => {
            // Fallback to gradient if image fails to load
            const target = e.target as HTMLImageElement;
            target.style.display = 'none';
            if (target.parentElement) {
              target.parentElement.innerHTML = `
                <div class="w-full h-full bg-gradient-to-br ${getGradient(username)} flex items-center justify-center text-white font-semibold">
                  ${getInitials(username)}
                </div>
              `;
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className={`${sizeClass} rounded-full bg-gradient-to-br ${getGradient(username)} flex items-center justify-center text-white font-semibold flex-shrink-0 border-2 border-white/20 ${className}`}>
      {getInitials(username)}
    </div>
  );
}
