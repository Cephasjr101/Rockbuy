// Fake supplier so you can run the shop with no API keys.
module.exports = {
  async search(q) {
    const base = q || 'item';
    return [1, 2, 3, 4, 5, 6].map(n => ({
      id: `mock-${base}-${n}`,
      title: `${base} sample ${n}`,
      image: '',
      cny: 20 * n,
      kg: 0.3 * n,
    }));
  },
};
