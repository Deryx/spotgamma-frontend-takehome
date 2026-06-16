import React, { useState, useRef } from 'react';

// --- Types & Constants ---
const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
const ROWS = Array.from({ length: 10 }, (_, i) => (i + 1).toString());

interface CellData {
  id: string;       // e.g., "A1"
  raw: string;      // e.g., "=B1 + C2" or "42"
  computed: string; // The evaluated result or error message
}

interface SpreadsheetState {
  [cellId: string]: CellData;
}

// Map of cellId -> Set of cellIds that THIS cell depends on
type DependencyGraph = Record<string, Set<string>>;

function App() {
// 1. Initialize spreadsheet grid state
  const [grid, setGrid] = useState<SpreadsheetState>(() => {
    const initial: SpreadsheetState = {};
    COLS.forEach((col) => {
      ROWS.forEach((row) => {
        const id = `${col}${row}`;
        initial[id] = { id, raw: '', computed: '' };
      });
    });
    return initial;
  });

  // Track active editing cell and global evaluation errors
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const [errorNotification, setErrorNotification] = useState<string | null>(null);

  // Keep track of dependencies using refs to avoid stale closures during rapid state updates
  // deps: key depends on values -> e.g., A1: =B1 + C1 means deps['A1'] = ['B1', 'C1']
  const depsRef = useRef<DependencyGraph>({});
  // revDeps: values depend on key -> e.g., revDeps['B1'] = ['A1']
  const revDepsRef = useRef<DependencyGraph>({});

  // --- Cycle Detection Helper ---
  // Returns true if introducing a link where `cellId` depends on `dependencyId` creates a cycle.
  const wouldCreateCycle = (cellId: string, dependencyId: string): boolean => {
    if (cellId === dependencyId) return true;
    
    const visited = new Set<string>();
    const queue = [dependencyId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === cellId) return true;
      
      visited.add(current);
      // Get everything that 'current' depends on
      const currentDeps = depsRef.current[current];
      if (currentDeps) {
        for (const nextDep of currentDeps) {
          if (!visited.has(nextDep)) {
            queue.push(nextDep);
          }
        }
      }
    }
    return false;
  };

  // --- Formula Parser & Evaluator ---
  const parseAndEvaluate = (raw: string, currentGrid: SpreadsheetState): string => {
    if (!raw.startsWith('=')) return raw;

    const formula = raw.slice(1).toUpperCase().trim();

    try {
      // 1. Handle Functions (SUM, AVERAGE)
      const rangeRegex = /(SUM|AVERAGE)\s*\(\s*([A-J][1-10]+)\s*:\s*([A-J][1-10]+)\s*\)/i;
      const match = formula.match(rangeRegex);

      if (match) {
        const [, func, startCell, endCell] = match;
        const values = getRangeValues(startCell, endCell, currentGrid);
        
        if (func === 'SUM') {
          return values.reduce((sum, val) => sum + val, 0).toString();
        }
        if (func === 'AVERAGE') {
          return values.length ? (values.reduce((sum, val) => sum + val, 0) / values.length).toString() : '0';
        }
      }

      // 2. Handle Simple Arithmetic Expressions (e.g., A1 + B2 * 3)
      // Tokenize cells vs operators/numbers
      const tokenRegex = /([A-J][1-10]+)|(\d+(?:\.\d+)?)|([+\-*/()])/g;
      const tokens = formula.match(tokenRegex);

      if (!tokens) throw new Error('#VALUE!');

      const evaluatedTokens = tokens.map(token => {
        // If it's a cell reference, swap it with its numeric value
        if (/^[A-J][1-10]+$/.test(token)) {
          const cellVal = currentGrid[token]?.computed || '0';
          const num = parseFloat(cellVal);
          return isNaN(num) ? '0' : num.toString();
        }
        return token;
      });

      // Safely evaluate the constructed math string
      // (Using Function constructor restricted to tokenized mathematical symbols for safety)
      const mathExpression = evaluatedTokens.join(' ');
      if (!/^[0-9\s+\-*/()\.]+$/.test(mathExpression)) {
        throw new Error('#NAME?');
      }
      
      const result = new Function(`return (${mathExpression})`)();
      return typeof result === 'number' && !isNaN(result) ? result.toString() : '#VALUE!';

    } catch (err) {
      return '#ERR!';
    }
  };

  // Extracts cell values within a bounding box range (e.g., A1:B3)
  const getRangeValues = (start: string, end: string, currentGrid: SpreadsheetState): number[] => {
    const startCol = start.charCodeAt(0);
    const startRow = parseInt(start.slice(1));
    const endCol = end.charCodeAt(0);
    const endRow = parseInt(end.slice(1));

    const minCol = Math.min(startCol, endCol);
    const maxCol = Math.max(startCol, endCol);
    const minRow = Math.min(startRow, endRow);
    const maxRow = Math.max(startRow, endRow);

    const values: number[] = [];

    for (let c = minCol; c <= maxCol; c++) {
      for (let r = minRow; r <= maxRow; r++) {
        const cellId = `${String.fromCharCode(c)}${r}`;
        const val = parseFloat(currentGrid[cellId]?.computed || '0');
        if (!isNaN(val)) values.push(val);
      }
    }
    return values;
  };

  // Identifies cell references inside a raw formula string
  const extractDependencies = (raw: string): string[] => {
    if (!raw.startsWith('=')) return [];
    const formula = raw.slice(1).toUpperCase();
    
    // Check for range patterns first (e.g., A1:B3)
    const rangeRegex = /([A-J][1-10]+)\s*:\s*([A-J][1-10]+)/g;
    let match;
    const deps = new Set<string>();

    while ((match = rangeRegex.exec(formula)) !== null) {
      const start = match[1];
      const end = match[2];
      const startCol = start.charCodeAt(0);
      const startRow = parseInt(start.slice(1));
      const endCol = end.charCodeAt(0);
      const endRow = parseInt(end.slice(1));
      
      for (let c = Math.min(startCol, endCol); c <= Math.max(startCol, endCol); c++) {
        for (let r = Math.min(startRow, endRow); r <= Math.max(startRow, endRow); r++) {
          deps.add(`${String.fromCharCode(c)}${r}`);
        }
      }
    }

    // Capture standalone cell references (not part of a range syntax)
    const standaloneRegex = /\b[A-J][1-10]+\b/g;
    const standaloneMatches = formula.match(standaloneRegex) || [];
    standaloneMatches.forEach(cell => deps.add(cell));

    return Array.from(deps);
  };

  // --- Core State Updates & Reactivity ---
  const handleCellChange = (cellId: string, newRawValue: string) => {
    setErrorNotification(null);
    const nextDeps = extractDependencies(newRawValue);

    // 1. Cycle Detection Guard
    for (const depId of nextDeps) {
      if (wouldCreateCycle(cellId, depId)) {
        setErrorNotification(`Circular Dependency Blocked: Setting ${cellId} would loop with ${depId}`);
        return; // Reject formula update safely
      }
    }

    // 2. Update Graph Metadata safely
    // Remove old mappings
    const oldDeps = depsRef.current[cellId] || new Set();
    oldDeps.forEach(oldDep => {
      revDepsRef.current[oldDep]?.delete(cellId);
    });
    
    // Insert new mappings
    depsRef.current[cellId] = new Set(nextDeps);
    nextDeps.forEach(newDep => {
      if (!revDepsRef.current[newDep]) revDepsRef.current[newDep] = new Set();
      revDepsRef.current[newDep].add(cellId);
    });

    // 3. Batch updates reactively through the graph
    setGrid(prevGrid => {
      const updatedGrid = { ...prevGrid };
      
      // Update the originating target cell
      updatedGrid[cellId] = {
        ...updatedGrid[cellId],
        raw: newRawValue,
        computed: parseAndEvaluate(newRawValue, updatedGrid)
      };

      // Recurse dynamically down the dependency line
      const propagateUpdates = (targetId: string) => {
        const dependents = revDepsRef.current[targetId];
        if (!dependents) return;

        dependents.forEach(depId => {
          updatedGrid[depId] = {
            ...updatedGrid[depId],
            computed: parseAndEvaluate(updatedGrid[depId].raw, updatedGrid)
          };
          // Cascade downwards
          propagateUpdates(depId);
        });
      };

      propagateUpdates(cellId);
      return updatedGrid;
    });
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
      <h2 style={{ margin: '0 0 5px 0' }}>Reactive CSS Grid Spreadsheet</h2>
      <p style={{ color: '#666', fontSize: '14px', margin: '0 0 15px 0' }}>
        Supports math operators (<code>+,-,*,/</code>) and ranges (<code>=SUM(A1:B2)</code>).
      </p>

      {errorNotification && (
        <div style={{ backgroundColor: '#ffe3e3', color: '#d92525', padding: '10px', borderRadius: '4px', marginBottom: '15px', fontWeight: 'bold' }}>
          {errorNotification}
        </div>
      )}

      {/* Grid wrapper container matching A-J (10 cols + 1 for index labels) */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '40px repeat(10, minmax(80px, 1fr))',
        gap: '1px',
        backgroundColor: '#ccc',
        border: '1px solid #ccc',
        maxWidth: '1000px',
        overflowX: 'auto'
      }}>
        {/* Top-Left Dead Corner Cell */}
        <div style={{ backgroundColor: '#f0f0f0' }}></div>
        
        {/* Column Headers (A-J) */}
        {COLS.map(col => (
          <div key={col} style={{ backgroundColor: '#e1e1e1', textAlign: 'center', fontWeight: 'bold', padding: '6px 0', fontSize: '14px' }}>
            {col}
          </div>
        ))}

        {/* Rows Generation */}
        {ROWS.map(row => (
          <React.Fragment key={row}>
            {/* Row Header Label (1-10) */}
            <div style={{ backgroundColor: '#e1e1e1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: '14px' }}>
              {row}
            </div>

            {/* Editable Content Cells */}
            {COLS.map(col => {
              const cellId = `${col}${row}`;
              const cell = grid[cellId];
              const isEditing = editingCell === cellId;

              return (
                <div 
                  key={cellId} 
                  style={{ backgroundColor: '#fff', minHeight: '30px', position: 'relative' }}
                >
                  {isEditing ? (
                    <input
                      autoFocus
                      type="text"
                      value={cell.raw}
                      onChange={(e) => handleCellChange(cellId, e.target.value)}
                      onBlur={() => setEditingCell(null)}
                      onKeyDown={(e) => e.key === 'Enter' && setEditingCell(null)}
                      style={{
                        width: '100%',
                        height: '100%',
                        border: '2px solid #0078d4',
                        outline: 'none',
                        boxSizing: 'border-box',
                        padding: '4px',
                        fontSize: '13px'
                      }}
                    />
                  ) : (
                    <div
                      onClick={() => setEditingCell(cellId)}
                      title={`Cell: ${cellId}\nFormula: ${cell.raw}`}
                      style={{
                        width: '100%',
                        height: '100%',
                        minHeight: '30px',
                        display: 'flex',
                        alignItems: 'center',
                        padding: '4px',
                        boxSizing: 'border-box',
                        cursor: 'text',
                        fontSize: '13px',
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                        color: cell.computed.startsWith('#') ? '#d92525' : '#000',
                        fontWeight: cell.raw.startsWith('=') ? '500' : 'normal'
                      }}
                    >
                      {cell.computed}
                    </div>
                  )}
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};

export default App
