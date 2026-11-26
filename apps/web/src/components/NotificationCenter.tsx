import React, { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Bell,
  BellOff,
  CalendarCheck,
  Check,
  CheckCheck,
  CheckCircle2,
  Clock,
  AlertTriangle,
  MessageSquare,
  Settings,
  Trash2,
  Inbox,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSocket } from '../hooks/useSocket';
import { apiFetch } from '../lib/api';
import { DataLoader } from './DataLoader';

type Tab = 'all' | 'unread' | 'tasks' | 'requests' | 'mentions';
const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'requests', label: 'Requests' },
  { id: 'mentions', label: 'Mentions' },
];

interface NotificationItem {
  _id: string;
  type: string;
  title: string;
  message?: string;
  link?: string;
  read: boolean;
  createdAt: string;
}

/** "Just now", "8m", "1h", "3d", then a date. */
function relativeTime(dateStr: string) {
  const diffSec = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diffSec < 60) return 'Just now';
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Today / Yesterday / Earlier, by the viewer's local day. */
function dayGroup(dateStr: string): 'Today' | 'Yesterday' | 'Earlier' {
  const d = new Date(dateStr);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (d >= start) return 'Today';
  start.setDate(start.getDate() - 1);
  return d >= start ? 'Yesterday' : 'Earlier';
}

/** Icon and tint by kind of notification. */
function iconFor(type = '') {
  if (type.includes('blocked') || type.includes('overdue') || type.includes('rejected'))
    return { Icon: AlertTriangle, cls: 'bg-rose-50 text-rose-600' };
  if (type.includes('approaching') || type.includes('reminder')) return { Icon: Clock, cls: 'bg-amber-50 text-amber-600' };
  if (type.includes('comment') || type.includes('mention') || type.includes('chat')) return { Icon: MessageSquare, cls: 'bg-sky-50 text-sky-600' };
  if (type.includes('approved') || type.includes('decided') || type.includes('accepted') || type.includes('published'))
    return { Icon: CheckCircle2, cls: 'bg-emerald-50 text-emerald-600' };
  if (type.includes('plan')) return { Icon: CalendarCheck, cls: 'bg-ui-blue-soft text-ui-ink' };
  return { Icon: Inbox, cls: 'bg-ui-card text-ui-ink' };
}

export const NotificationCenter: React.FC = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('all');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { on } = useSocket();

  // Close on outside click or Escape (focus goes back to the bell).
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) setIsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  // New notifications arrive over the socket.
  useEffect(() => {
    const offNew = on('notification:new', () => queryClient.invalidateQueries({ queryKey: ['notifications'] }));
    const offStatus = on('status_change', () => queryClient.invalidateQueries({ queryKey: ['notifications'] }));
    return () => {
      offNew();
      offStatus();
    };
  }, [on, queryClient]);

  const { data: notificationsData, isLoading } = useQuery({
    queryKey: ['notifications', activeTab],
    queryFn: async () => {
      let url = `/api/notifications?limit=25`;
      if (activeTab === 'unread') url += '&unreadOnly=true';
      else if (activeTab !== 'all') url += `&type=${activeTab}`;
      // apiFetch sends the login cookie and renews it once if it has expired.
      return apiFetch<any>(url).catch(() => ({ data: [], unreadCount: 0 }));
    },
    refetchInterval: 30000,
  });

  const notifications: NotificationItem[] = notificationsData?.data || [];
  const unreadCount: number = notificationsData?.unreadCount || 0;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });

  const markAllRead = useMutation({ mutationFn: () => apiFetch('/api/notifications/read-all', { method: 'PATCH' }), onSuccess: refresh });
  const markRead = useMutation({ mutationFn: (id: string) => apiFetch(`/api/notifications/${id}/read`, { method: 'PATCH' }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => apiFetch(`/api/notifications/${id}`, { method: 'DELETE' }), onSuccess: refresh });

  const openItem = (n: NotificationItem) => {
    if (!n.read) markRead.mutate(n._id);
    if (n.link) {
      setIsOpen(false);
      navigate(n.link);
    }
  };

  const groups = (['Today', 'Yesterday', 'Earlier'] as const)
    .map((label) => ({ label, items: notifications.filter((n) => dayGroup(n.createdAt) === label) }))
    .filter((g) => g.items.length > 0);

  return (
    <div ref={dropdownRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        title="Notifications"
        className={`relative flex h-10 w-10 items-center justify-center rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-ink ${
          isOpen ? 'border-ui-ink bg-white text-ui-ink' : 'border-white/90 bg-white/70 text-slate-600 hover:bg-white'
        }`}
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white ring-2 ring-white"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          role="region"
          aria-label="Notifications"
          className="absolute right-0 z-50 mt-2 w-[min(92vw,400px)] overflow-hidden rounded-2xl border border-ui-line bg-white shadow-ui-modal animate-in fade-in slide-in-from-top-2 duration-150"
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-2 px-4 pt-4">
            <h2 className="text-[15px] font-semibold text-ui-ink">Notifications</h2>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => markAllRead.mutate()}
                disabled={unreadCount === 0 || markAllRead.isPending}
                className="inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-semibold text-ui-text transition-colors hover:bg-ui-card disabled:cursor-default disabled:text-ui-muted/60 disabled:hover:bg-transparent"
              >
                <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
                Mark all as read
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  navigate('/settings');
                }}
                aria-label="Notification settings"
                title="Notification settings"
                className="flex h-8 w-8 items-center justify-center rounded-full text-ui-muted transition-colors hover:bg-ui-card hover:text-ui-ink"
              >
                <Settings className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div role="tablist" aria-label="Filter notifications" className="mt-2 flex gap-1 overflow-x-auto border-b border-ui-line px-3 no-scrollbar">
            {TABS.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveTab(tab.id)}
                  className={`relative -mb-px inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2 text-[13px] font-medium transition-colors ${
                    active ? 'border-ui-ink text-ui-ink' : 'border-transparent text-ui-muted hover:text-ui-ink'
                  }`}
                >
                  {tab.label}
                  {tab.id === 'unread' && unreadCount > 0 && (
                    <span className="rounded-full bg-rose-500 px-1.5 text-[10px] font-bold leading-4 text-white">{unreadCount > 99 ? '99+' : unreadCount}</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* List */}
          <div className="max-h-[420px] overflow-y-auto">
            {isLoading ? (
              <DataLoader label="Loading notifications…" />
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-ui-card text-ui-muted">
                  <BellOff className="h-5 w-5" aria-hidden="true" />
                </span>
                <p className="text-sm font-semibold text-ui-ink">{activeTab === 'unread' ? "You're all caught up" : 'No notifications yet'}</p>
                <p className="text-[13px] text-ui-muted">
                  {activeTab === 'unread' ? 'New updates will show up here.' : 'Plan reviews, tasks and mentions will appear here.'}
                </p>
              </div>
            ) : (
              groups.map((g) => (
                <section key={g.label} aria-label={g.label}>
                  <h3 className="sticky top-0 z-10 bg-white/95 px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-ui-muted backdrop-blur">
                    {g.label}
                  </h3>
                  <ul>
                    {g.items.map((n) => {
                      const unread = !n.read;
                      const { Icon, cls } = iconFor(n.type);
                      return (
                        <li key={n._id} className="group relative">
                          <button
                            type="button"
                            onClick={() => openItem(n)}
                            className={`flex w-full items-start gap-3 px-4 py-3 pr-16 text-left transition-colors hover:bg-ui-card/70 focus:outline-none focus-visible:bg-ui-card ${
                              unread ? 'bg-ui-blue-soft/30' : ''
                            }`}
                            aria-label={`${unread ? 'Unread: ' : ''}${n.title}. ${n.message || ''} ${relativeTime(n.createdAt)}.${n.link ? ' Opens the item.' : ''}`}
                          >
                            <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${cls}`} aria-hidden="true">
                              <Icon className="h-4 w-4" />
                            </span>
                            <span className="min-w-0 flex-1" aria-hidden="true">
                              <span className={`block truncate text-[13px] leading-snug ${unread ? 'font-semibold text-ui-ink' : 'font-medium text-ui-text'}`}>
                                {n.title}
                              </span>
                              {n.message && <span className="mt-0.5 block line-clamp-2 text-[12.5px] leading-relaxed text-ui-muted">{n.message}</span>}
                              <span className="mt-1 block text-[11px] text-ui-muted">{relativeTime(n.createdAt)}</span>
                            </span>
                            {unread && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-ui-blue" aria-hidden="true" />}
                          </button>

                          {/* Row actions: on hover, or when a row button has keyboard focus */}
                          <div className="absolute right-3 top-3 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                            {unread && (
                              <button
                                type="button"
                                onClick={() => markRead.mutate(n._id)}
                                aria-label={`Mark as read: ${n.title}`}
                                title="Mark as read"
                                className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-ui-muted shadow-sm transition-colors hover:text-emerald-600"
                              >
                                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => remove.mutate(n._id)}
                              aria-label={`Delete notification: ${n.title}`}
                              title="Delete"
                              className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-ui-muted shadow-sm transition-colors hover:text-rose-600"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-ui-line">
            <Link
              to="/notifications"
              onClick={() => setIsOpen(false)}
              className="flex h-11 items-center justify-center text-[13px] font-semibold text-ui-ink transition-colors hover:bg-ui-card"
            >
              View all notifications
            </Link>
          </div>
        </div>
      )}
    </div>
  );
};
