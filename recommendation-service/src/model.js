'use strict';
// Popularity model built ONLY from events (eventually consistent read model, L2 p.142-143).
// Stands in for the data team's Python model: it consumes the same event contract (JSON over
// RabbitMQ), so the real model can replace this service without changing any other service.
// Signals: OrderPlaced (each unit sold scores PURCHASE_WEIGHT) and ProductViewed (each view scores 1).
// It keeps product ids and scores only; customer ids and contact details are discarded on arrival
// (data minimisation), so this service holds no personal data.
const PURCHASE_WEIGHT = 5;
function createModel() {
  const counts = new Map();
  const seen = new Set();
  return {
    apply(event) {
      if (seen.has(event.eventId)) return false;
      const add = (id, score) => counts.set(id, (counts.get(id) || 0) + score);
      if (event.type === 'OrderPlaced') for (const item of event.data.items || []) add(item.productId, item.quantity * PURCHASE_WEIGHT);
      else if (event.type === 'ProductViewed') add(event.data.productId, 1);
      else return false;
      seen.add(event.eventId);
      return true;
    },
    top(limit, exclude = []) {
      return [...counts.entries()]
        .filter(([id]) => !exclude.includes(id))
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([productId, score]) => ({ productId, score }));
    },
  };
}
module.exports = { createModel };
