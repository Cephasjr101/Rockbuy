// 1688 via the Onebound third-party API wrapper.
// Check the field names against their current docs before going live.
// 1688 search works best with Chinese keywords; add a translation step for English queries.
module.exports = {
  async search(q) {
    const { OB_KEY, OB_SECRET } = process.env;
    if (!OB_KEY || !OB_SECRET) throw new Error('Set OB_KEY and OB_SECRET');
    const u = `https://api-gw.onebound.cn/1688/item_search/?key=${OB_KEY}&secret=${OB_SECRET}&q=${encodeURIComponent(q)}&page=1&lang=en`;
    const j = await (await fetch(u)).json();
    const list = (j.items && j.items.item) || [];
    return list.map(i => ({
      id: String(i.num_iid),
      title: i.title,
      image: (i.pic_url || '').startsWith('//') ? 'https:' + i.pic_url : i.pic_url || '',
      cny: Number(i.price) || 0,
      kg: 0.5, // search results carry no weight; refine with item_get later
    })).filter(p => p.cny > 0);
  },
};
