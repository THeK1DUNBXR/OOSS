/**
 * "Course & Fee Master" — the reference tool's searchable price-list view:
 * every course's tenure-based monthly rates side by side, and every add-on
 * beneath it. Read-only here; the fee plans and add-ons themselves are
 * managed from the course's own edit form (`CourseForm` in `Courses.tsx`).
 */
import { useMemo, useState } from 'react';
import type { CourseView } from '@kaizen/shared';
import { KI_APP_CSS } from './style.js';
import { fmtINR } from './calc.js';

function feeCell(monthlyFee: number | undefined) {
  return monthlyFee !== undefined ? <td className="ki-num-cell">{fmtINR(monthlyFee)}</td> : (
    <td className="ki-num-cell">
      <span className="ki-badge ki-na">n/a</span>
    </td>
  );
}

export function FeeMasterCatalog({ courses }: { courses: CourseView[] }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const filteredCourses = useMemo(() => courses.filter((c) => c.name.toLowerCase().includes(q)), [courses, q]);
  const addons = useMemo(
    () => courses.flatMap((c) => c.addons.map((a) => ({ course: c, addon: a }))),
    [courses],
  );
  const filteredAddons = useMemo(
    () => addons.filter(({ course, addon }) => course.name.toLowerCase().includes(q) || addon.name.toLowerCase().includes(q)),
    [addons, q],
  );

  return (
    <div className="ki-app">
      <main className="ki-main">
        <div className="ki-catalog-toolbar">
          <input type="text" placeholder="Search courses or add-ons…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <span className="ki-count">
            {filteredCourses.length} courses, {filteredAddons.length} add-ons
          </span>
        </div>

        <div className="ki-cat-section">
          <h3>Courses</h3>
          <div className="ki-cat-scroll">
            <table className="ki-cat">
              <thead>
                <tr>
                  <th>Course</th>
                  <th>1-Month</th>
                  <th>3-Month</th>
                  <th>6-Month</th>
                  <th>8-Month</th>
                  <th>Hours</th>
                  <th>SAC</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {filteredCourses.map((c) => {
                  const byTenure = new Map(c.feePlans.map((p) => [p.tenureMonths, p.monthlyFee]));
                  return (
                    <tr key={c.id}>
                      <td>
                        <b>{c.name}</b>
                      </td>
                      {feeCell(byTenure.get(1))}
                      {feeCell(byTenure.get(3))}
                      {feeCell(byTenure.get(6))}
                      {feeCell(byTenure.get(8))}
                      <td className="ki-num-cell">{c.hours !== null ? `${c.hours} hrs` : '—'}</td>
                      <td>{c.hsnSac ?? ''}</td>
                      <td className="ki-notes-cell">{c.description ?? ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="ki-cat-section">
          <h3>Add-ons</h3>
          <div className="ki-cat-scroll">
            <table className="ki-cat">
              <thead>
                <tr>
                  <th>Course</th>
                  <th>Add-on</th>
                  <th>Fixed Price</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {filteredAddons.map(({ course, addon }) => (
                  <tr key={addon.id}>
                    <td>{course.name}</td>
                    <td>
                      <b>{addon.name}</b>
                    </td>
                    <td className="ki-num-cell">{fmtINR(addon.price)}</td>
                    <td className="ki-notes-cell">{addon.notes ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>
      <style>{KI_APP_CSS}</style>
    </div>
  );
}
