/**
 * Deterministic clustered spring layout, ported unchanged from the UI it came
 * with. Structurally typed rather than bound to the graph model, so the layout
 * never has to change when the ledger gains a field.
 *
 * Determinism matters: the same graph must lay out the same way every reload,
 * or people lose the spatial memory they build up of their own network.
 */
export type Point = { x: number; y: number };

export interface LayoutGraph {
  entities: Array<{ id: string }>;
  edges: Array<{ source: string; target: string }>;
}
/** Deterministic spring layout: edges attract, nodes repel, collisions reserve label space. */
export function networkLayout(graph:LayoutGraph):Record<string,Point>{
 const nodes=[...graph.entities].sort((a,b)=>a.id.localeCompare(b.id));
 const points=nodes.map((n,i)=>({id:n.id,x:Math.cos(i*2.39996)*Math.sqrt(i+1)*75,y:Math.sin(i*2.39996)*Math.sqrt(i+1)*75,vx:0,vy:0}));
 const index=new Map(points.map((n,i)=>[n.id,i]));
 const links=graph.edges.map(e=>[index.get(e.source),index.get(e.target)]).filter((p):p is [number,number]=>p[0]!==undefined&&p[1]!==undefined&&p[0]!==p[1]);
 const parent=points.map((_,i)=>i);const root=(i:number):number=>parent[i]===i?i:(parent[i]=root(parent[i]));for(const [a,b] of links)parent[root(b)]=root(a);
 const groups=[...new Set(points.map((_,i)=>root(i)))];const centers=points.map((_,i)=>{const group=groups.indexOf(root(i)),angle=group*2.39996,r=groups.length===1?0:Math.sqrt(group+1)*Math.sqrt(points.length)*140;return {x:Math.cos(angle)*r,y:Math.sin(angle)*r};});
 points.forEach((p,i)=>{p.x+=centers[i].x;p.y+=centers[i].y;});
 for(let tick=0;tick<260;tick++){
  const alpha=1-tick/300;
  for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++){
   const a=points[i],b=points[j],dx=b.x-a.x,dy=b.y-a.y,d=Math.max(1,Math.hypot(dx,dy));
   const force=Math.min(18,2500/(d*d)+Math.max(0,140-d)*.08)*alpha;
   a.vx-=dx/d*force;a.vy-=dy/d*force;b.vx+=dx/d*force;b.vy+=dy/d*force;
  }
  for(const [i,j] of links){const a=points[i],b=points[j],dx=b.x-a.x,dy=b.y-a.y,d=Math.max(1,Math.hypot(dx,dy)),force=(d-175)*.018*alpha;a.vx+=dx/d*force;a.vy+=dy/d*force;b.vx-=dx/d*force;b.vy-=dy/d*force;}
  for(let i=0;i<points.length;i++){const n=points[i];n.vx=(n.vx-(n.x-centers[i].x)*.0008*alpha)*.72;n.vy=(n.vy-(n.y-centers[i].y)*.0008*alpha)*.72;n.x+=n.vx;n.y+=n.vy;}
 }
 return Object.fromEntries(points.map(n=>[n.id,{x:n.x,y:n.y}]));
}
export function fitNetwork(points:Record<string,Point>){const values=Object.values(points);if(!values.length)return {x:425,y:250,k:1};const minX=Math.min(...values.map(p=>p.x))-100,maxX=Math.max(...values.map(p=>p.x))+100,minY=Math.min(...values.map(p=>p.y))-65,maxY=Math.max(...values.map(p=>p.y))+95;const k=Math.min(1.3,780/(maxX-minX),460/(maxY-minY));return {x:425-(minX+maxX)/2*k,y:250-(minY+maxY)/2*k,k};}
