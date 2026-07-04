import { NavLink } from 'react-router-dom';
import {
  LogoMark,
  Wordmark,
  CollapseIcon,
  BookIcon,
  ProjectsIcon,
  DiscussionsIcon,
  LeaderboardsIcon,
  CommunityIcon,
  ShopIcon,
  LockBadge,
} from './icons';

const LOCKED = [
  { label: 'Projects', Icon: ProjectsIcon },
  { label: 'Discussions', Icon: DiscussionsIcon },
  { label: 'Leaderboards', Icon: LeaderboardsIcon },
  { label: 'Community', Icon: CommunityIcon },
  { label: 'Shop', Icon: ShopIcon },
];

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="sidebar-head">
        <div className="brand">
          <LogoMark className="brand-logo" />
          <Wordmark className="brand-word" />
        </div>
        <button
          className="icon-btn collapse"
          type="button"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={onToggle}
        >
          <CollapseIcon />
        </button>
      </div>

      <nav className="nav">
        <NavLink to="/" end className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          <span className="nav-ico"><BookIcon /></span>
          <span className="nav-label">Learn</span>
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          <span className="nav-ico"><ProjectsIcon /></span>
          <span className="nav-label">Settings</span>
        </NavLink>

        <hr className="nav-divider" />

        {LOCKED.map(({ label, Icon }) => (
          <div className="nav-item locked" key={label} aria-disabled="true">
            <span className="nav-ico">
              <Icon />
              <LockBadge className="lock" />
            </span>
            <span className="nav-label">{label}</span>
          </div>
        ))}
      </nav>

      <div className="sidebar-foot">
        <div className="avatar-sm">O</div>
        <div className="user-meta">
          <div className="user-name">Omer Erez</div>
          <div className="user-email">omer.e@fellowship.masterschool.com</div>
        </div>
      </div>
    </aside>
  );
}
