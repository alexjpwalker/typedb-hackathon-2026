<script lang="ts">
  import { onMount } from 'svelte';
  import { outlets, donutTypes, selectedOutlet, selectedDonutType } from '../stores';
  import type { Outlet } from '../types';

  // Inventory per outlet: outletId -> { donutTypeId -> quantity }
  // Using a reactive key to force re-renders when inventory changes
  let inventories: Record<string, Record<string, number>> = {};
  let inventoryKey = 0;

  function formatBalance(balance: number | undefined): string {
    return balance !== undefined ? balance.toFixed(2) : '0.00';
  }

  function formatMargin(margin: number | undefined): string {
    return margin !== undefined ? `${margin}%` : 'N/A';
  }

  async function fetchInventory(outletId: string) {
    try {
      const response = await fetch(`http://localhost:3000/api/outlets/${outletId}/inventory`);
      if (response.ok) {
        const data = await response.json();
        inventories[outletId] = data;
        inventories = {...inventories}; // trigger reactivity with new object
        inventoryKey++; // force re-render
      } else {
        console.error(`Failed to fetch inventory for ${outletId}: ${response.status}`);
      }
    } catch (error) {
      console.error(`Error fetching inventory for ${outletId}:`, error);
    }
  }

  async function fetchAllInventories() {
    for (const outlet of $outlets) {
      await fetchInventory(outlet.outletId);
    }
  }

  function formatInventory(outletId: string): string {
    const inv = inventories[outletId];
    if (!inv) return 'No inventory';
    const items = Object.entries(inv)
      .filter(([_, qty]) => qty > 0)
      .map(([type, qty]) => `${type}: ${qty}`);
    return items.length > 0 ? items.join(', ') : 'No inventory';
  }

  function getTotalInventory(outletId: string): number {
    const inv = inventories[outletId];
    if (!inv) return 0;
    return Object.values(inv).reduce((sum, qty) => sum + qty, 0);
  }

  onMount(() => {
    // Refresh inventory every 2 seconds
    const interval = setInterval(fetchAllInventories, 2000);
    return () => clearInterval(interval);
  });

  // Re-fetch inventory whenever outlets change (ensures we have outlet IDs)
  $: if ($outlets.length > 0) {
    fetchAllInventories();
  }

  async function toggleOutlet(outlet: Outlet, event: MouseEvent) {
    event.stopPropagation(); // Prevent outlet selection
    const newStatus = !outlet.isOpen;

    try {
      const response = await fetch(`http://localhost:3000/api/outlets/${outlet.outletId}/toggle`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isOpen: newStatus })
      });

      if (!response.ok) throw new Error('Failed to toggle outlet');

      // Update local state
      outlet.isOpen = newStatus;
      outlets.set($outlets);
    } catch (error) {
      console.error('Error toggling outlet:', error);
    }
  }

  async function toggleAll(isOpen: boolean) {
    try {
      const response = await fetch('http://localhost:3000/api/outlets/toggle-all', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isOpen })
      });

      if (!response.ok) throw new Error('Failed to toggle all outlets');

      // Update local state
      $outlets.forEach(o => o.isOpen = isOpen);
      outlets.set($outlets);
    } catch (error) {
      console.error('Error toggling all outlets:', error);
    }
  }
</script>

<div class="selector-container">
  <!-- Outlet Selector -->
  <div class="selector-section">
    <div class="section-header">
      <h3>Select Outlet</h3>
      <div class="toggle-all-buttons">
        <button class="toggle-all-btn open" on:click={() => toggleAll(true)}>Open All</button>
        <button class="toggle-all-btn close" on:click={() => toggleAll(false)}>Close All</button>
      </div>
    </div>
    {#if $outlets.length > 0}
      <div class="selector-grid">
        {#each $outlets as outlet (outlet.outletId)}
          <button
            class="selector-card"
            class:active={$selectedOutlet?.outletId === outlet.outletId}
            class:closed={!outlet.isOpen}
            on:click={() => selectedOutlet.set(outlet)}
          >
            <div class="card-header">
              <strong>{outlet.outletName}</strong>
              <span class="badge">${formatBalance(outlet.balance)}</span>
            </div>
            <div class="card-body">
              <span class="location">{outlet.location}</span>
              <span class="margin-info">Retail Margin: {formatMargin(outlet.marginPercent)}</span>
              {#key inventoryKey}
              <div class="inventory-info">
                <span class="inventory-label">Inventory ({getTotalInventory(outlet.outletId)} total):</span>
                <span class="inventory-items">{formatInventory(outlet.outletId)}</span>
              </div>
              {/key}
              <div class="status-controls">
                <span class="status-indicator" class:open={outlet.isOpen} class:closed={!outlet.isOpen}>
                  {outlet.isOpen ? '🟢 OPEN' : '🔴 CLOSED'}
                </span>
                <div
                  class="toggle-btn"
                  role="button"
                  tabindex="0"
                  on:click={(e) => toggleOutlet(outlet, e)}
                  on:keydown={(e) => e.key === 'Enter' && toggleOutlet(outlet, e)}
                >
                  {outlet.isOpen ? 'Close' : 'Open'}
                </div>
              </div>
            </div>
          </button>
        {/each}
      </div>
    {:else}
      <div class="empty">No outlets available</div>
    {/if}
  </div>

  <!-- Donut Type Selector -->
  <div class="selector-section">
    <h3>Select Donut Type</h3>
    {#if $donutTypes.length > 0}
      <div class="selector-grid">
        {#each $donutTypes as donutType (donutType.donutTypeId)}
          <button
            class="selector-card"
            class:active={$selectedDonutType?.donutTypeId === donutType.donutTypeId}
            on:click={() => selectedDonutType.set(donutType)}
          >
            <div class="card-header">
              <strong>{donutType.donutName}</strong>
            </div>
            <div class="card-body">
              <span class="description">{donutType.description}</span>
            </div>
          </button>
        {/each}
      </div>
    {:else}
      <div class="empty">No donut types available</div>
    {/if}
  </div>
</div>

<style>
  .selector-container {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .selector-section {
    background: white;
    border-radius: 8px;
    padding: 1.5rem;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  h3 {
    margin: 0;
    font-size: 1.25rem;
  }

  .toggle-all-buttons {
    display: flex;
    gap: 0.5rem;
  }

  .toggle-all-btn {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 6px;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .toggle-all-btn.open {
    background: #10b981;
    color: white;
  }

  .toggle-all-btn.open:hover {
    background: #059669;
  }

  .toggle-all-btn.close {
    background: #ef4444;
    color: white;
  }

  .toggle-all-btn.close:hover {
    background: #dc2626;
  }

  .selector-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
    gap: 0.75rem;
  }

  .selector-card {
    background: #f9fafb;
    border: 2px solid #e5e7eb;
    border-radius: 6px;
    padding: 1rem;
    cursor: pointer;
    transition: all 0.2s;
    text-align: left;
  }

  .selector-card:hover {
    border-color: #3b82f6;
    box-shadow: 0 2px 4px rgba(59, 130, 246, 0.2);
  }

  .selector-card.active {
    background: #eff6ff;
    border-color: #3b82f6;
    box-shadow: 0 2px 8px rgba(59, 130, 246, 0.3);
  }

  .selector-card.closed {
    opacity: 0.6;
    background: #fef2f2;
    border-color: #fca5a5;
  }

  .selector-card.closed:hover {
    border-color: #ef4444;
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .card-header strong {
    font-size: 1rem;
    color: #1f2937;
  }

  .badge {
    background: #10b981;
    color: white;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
  }

  .card-body {
    font-size: 0.875rem;
    color: #6b7280;
  }

  .location,
  .description {
    display: block;
  }

  .margin-info {
    display: block;
    margin-top: 0.25rem;
    font-size: 0.8rem;
    color: #7c3aed;
    font-weight: 500;
  }

  .inventory-info {
    display: block;
    margin-top: 0.5rem;
    padding: 0.5rem;
    background: #f0fdf4;
    border-radius: 4px;
    border: 1px solid #bbf7d0;
  }

  .inventory-label {
    display: block;
    font-size: 0.75rem;
    font-weight: 600;
    color: #166534;
    margin-bottom: 0.25rem;
  }

  .inventory-items {
    display: block;
    font-size: 0.7rem;
    color: #15803d;
  }

  .status-controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid #e5e7eb;
  }

  .status-indicator {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
  }

  .status-indicator.open {
    background: #d1fae5;
    color: #065f46;
  }

  .status-indicator.closed {
    background: #fee2e2;
    color: #991b1b;
  }

  .toggle-btn {
    padding: 0.25rem 0.75rem;
    font-size: 0.75rem;
    font-weight: 600;
    background: #6b7280;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.2s;
  }

  .toggle-btn:hover {
    background: #4b5563;
  }

  .empty {
    text-align: center;
    padding: 2rem;
    color: #9ca3af;
    font-style: italic;
  }
</style>
