import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DataTable } from './DataTable';

interface Row {
  id: string;
  name: string;
}
const rows: Row[] = [
  { id: '1', name: 'beta' },
  { id: '2', name: 'alpha' },
];
const columns = [
  {
    key: 'name',
    header: 'Name',
    sort: (a: Row, b: Row) => a.name.localeCompare(b.name),
    cell: (r: Row) => r.name,
  },
];

describe('DataTable', () => {
  it('sorts by a column header', () => {
    render(<DataTable caption="t" columns={columns} rows={rows} rowKey={(r) => r.id} />);
    fireEvent.click(screen.getByRole('button', { name: /name/i }));
    const cells = screen.getAllByRole('row').slice(1);
    expect(cells[0]).toHaveTextContent('alpha');
  });

  it('opens a row with Enter when keyboard focused', () => {
    const onRowClick = vi.fn();
    render(
      <DataTable caption="t" columns={columns} rows={rows} rowKey={(r) => r.id} onRowClick={onRowClick} />,
    );
    const row = screen.getAllByRole('row')[1] as HTMLElement;
    expect(row.tabIndex).toBe(0);
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
  });
});
