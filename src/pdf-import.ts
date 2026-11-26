import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { Item, Page, Notebook, clone, item, newPage, parseBook, newBook, stroke, uid, nativeTextStyle } from './model';
import { nativePreview, bindNative } from './pdf-native-preview';

export const ANNOTATION_ATTACHMENT='Penbook-annotations.json';
export interface AnnotationArchive {format:'penbook-annotations';version:1;resources:Notebook['resources'];pages:{width:number;height:number;annotations:{id:string;rect:number[];contents:string;native?:Record<string,unknown>;item:Item}[]}[];}
function sameNative(expected:unknown,actual:unknown):boolean{
  if(typeof expected==='number')return typeof actual==='number'&&Math.abs(expected-actual)<.01;
  if(Array.isArray(expected)){const values=ArrayBuffer.isView(actual)?Array.from(actual as unknown as ArrayLike<number>):actual;return Array.isArray(values)&&expected.length===values.length&&expected.every((value,i)=>sameNative(value,values[i]));}
  return expected===actual;
}
function matchesNative(saved:Record<string,unknown>|undefined,a:any){
  if(!saved)return false;
  const values={...a,color:a.color?Array.from(a.color):null,width:a.borderStyle?.width,fontSize:a.defaultAppearanceData?.fontSize,url:linkUrl(a)};
  return Object.entries(saved).every(([key,value])=>sameNative(value,values[key]));
}
const linkUrl=(a:any):string|undefined=>a.url??(typeof a.unsafeUrl==='string'&&a.unsafeUrl.startsWith('obsidian://')?a.unsafeUrl:undefined);
const color=(value:ArrayLike<number>|null|undefined,fallback='#000000')=>value?.length===3?'#'+Array.from(value).map(n=>Math.round(n).toString(16).padStart(2,'0')).join(''):fallback;
export async function destinationPage(pdf:PDFDocumentProxy,dest:any):Promise<number|undefined>{
  const value=typeof dest==='string'?await pdf.getDestination(dest):dest;
  if(!Array.isArray(value)||!value.length)return;
  try{return typeof value[0]==='number'?value[0]:await pdf.getPageIndex(value[0]);}catch{return;}
}
const clampOpacity=(value:unknown,fallback:number)=>typeof value==='number'&&Number.isFinite(value)?Math.max(0,Math.min(1,value)):fallback;
type Pt=[number,number,number];
const normalizeQuad=(pts:Pt[]):[Pt,Pt,Pt,Pt]=>{
  const byY=[...pts].sort((u,v)=>u[1]-v[1]||u[0]-v[0]);
  const [tl,tr]=byY.slice(0,2).sort((u,v)=>u[0]-v[0]||u[1]-v[1]);
  const [bl,br]=byY.slice(2,4).sort((u,v)=>u[0]-v[0]||u[1]-v[1]);
  return[tl,tr,bl,br];
};
const lerpPt=(a:Pt,b:Pt,t:number):Pt=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,.5];
function squigglyPoints(start:Pt,end:Pt,size:number):Pt[]{
  const dx=end[0]-start[0],dy=end[1]-start[1],len=Math.hypot(dx,dy);
  if(len<1e-3)return[start,end];
  const wavelength=Math.max(4,size*.28),amplitude=Math.max(1.2,size*.09),nx=-dy/len,ny=dx/len;
  const count=Math.max(4,Math.ceil(len/(wavelength/4))),pts:Pt[]=[];
  for(let i=0;i<=count;i++){
    const t=i/count,bx=start[0]+dx*t,by=start[1]+dy*t;
    const offset=i===0||i===count?0:Math.sin((t*len/wavelength)*Math.PI*2)*amplitude;
    pts.push([bx+nx*offset,by+ny*offset,.5]);
  }
  return pts;
}
export function annotationItems(annotation:any,p:PDFPageProxy):Item[]{
  const vp=p.getViewport({scale:1}),rect=annotation.rect as number[]|undefined;if(!rect?.every(Number.isFinite))return [];
  const [ax,ay]=vp.convertToViewportPoint(rect[0],rect[1]),[bx,by]=vp.convertToViewportPoint(rect[2],rect[3]),x=Math.min(ax,bx),y=Math.min(ay,by),w=Math.max(1,Math.abs(bx-ax)),h=Math.max(1,Math.abs(by-ay));
  const ink=color(annotation.color),contents=annotation.contentsObj?.str??annotation.contents??'',lineWidth=Math.max(.2,annotation.borderStyle?.width??1);
  const points=(values:ArrayLike<number>)=>{const result:Pt[]=[];for(let i=0;i+1<values.length;i+=2){const pt=vp.convertToViewportPoint(values[i],values[i+1]);result.push([pt[0],pt[1],.5]);}return result;};
  let result:Item[]=[];
  const isMarkup=[9,10,11,12].includes(annotation.annotationType)||['Highlight','Underline','StrikeOut','Squiggly'].includes(annotation.subtype);
  if(annotation.annotationType===3)result=[{...item('text',x,y,w,h,color(annotation.defaultAppearanceData?.fontColor)),text:contents,fontSize:annotation.defaultAppearanceData?.fontSize??16,opacity:clampOpacity(annotation.opacity,1)}];
  else if(annotation.annotationType===15){for(const list of annotation.inkLists??[]){const pts=points(list);if(pts.length)result.push({...stroke(pts,ink,lineWidth,'ballpoint'),opacity:clampOpacity(annotation.opacity,1)});}}
  else if(isMarkup){
    const subtype=annotation.subtype??(annotation.annotationType===10?'Underline':annotation.annotationType===11?'Squiggly':annotation.annotationType===12?'StrikeOut':undefined);
    const quads=annotation.quadPoints??[rect[0],rect[3],rect[2],rect[3],rect[0],rect[1],rect[2],rect[1]];
    for(let i=0;i<quads.length;i+=8){
      const raw=points(Array.from(quads).slice(i,i+8)as number[]);if(raw.length!==4)continue;
      const quad=normalizeQuad(raw),[tl,tr,bl,br]=quad;
      const size=Math.max(1,(Math.hypot(tl[0]-bl[0],tl[1]-bl[1])+Math.hypot(tr[0]-br[0],tr[1]-br[1]))/2);
      if(subtype==='Underline'||subtype==='StrikeOut'||subtype==='Squiggly'){
        const linePts:Pt[]=subtype==='StrikeOut'?[lerpPt(tl,bl,.5),lerpPt(tr,br,.5)]:subtype==='Squiggly'?squigglyPoints(lerpPt(tl,bl,.92),lerpPt(tr,br,.92),size):[lerpPt(tl,bl,.92),lerpPt(tr,br,.92)];
        const width=subtype==='Squiggly'?Math.max(.8,size*.07):Math.max(1,size*.08);
        const all=[...quad,...linePts];let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
        for(const[px,py]of all){minX=Math.min(minX,px);minY=Math.min(minY,py);maxX=Math.max(maxX,px);maxY=Math.max(maxY,py);}
        const ox=minX-width,oy=minY-width,ow=Math.max(1,maxX-ox+width),oh=Math.max(1,maxY-oy+width);
        const o=stroke(linePts,ink,width,'ballpoint');
        o.x=ox;o.y=oy;o.w=ow;o.h=oh;o.bw=ow;o.bh=oh;
        o.points=linePts.map(v=>[v[0]-ox,v[1]-oy,v[2]]);
        o.pdfMarkup={subtype,quadPoints:quad.map(v=>[v[0]-ox,v[1]-oy,v[2]])};
        o.opacity=clampOpacity(annotation.opacity,1);
        result.push(o);
      }else{
        const a=lerpPt(tl,bl,.5),b=lerpPt(tr,br,.5),o=stroke([a,b],ink,size,'highlighter');
        o.pdfMarkup={subtype,quadPoints:quad.map(v=>[v[0]-o.x,v[1]-o.y,v[2]])};
        o.frozenInk=[[tl,tr,br,bl].map(v=>[v[0]-o.x,v[1]-o.y])];
        o.opacity=clampOpacity(annotation.opacity,.35);
        result.push(o);
      }
    }
  }
  return result.map(o=>({...o,pdfAnnotationId:annotation.id,pdfMarkup:{...o.pdfMarkup,subtype:o.pdfMarkup?.subtype??annotation.subtype,contents,author:annotation.titleObj?.str,subject:annotation.subject,lineEndings:annotation.lineEndings}}));
}
export async function importPdfPages(pdf:PDFDocumentProxy,key:string,name:string,book:Notebook):Promise<Page[]>{
  const pages:Page[]=[],pending:{page:Page;link:NonNullable<Page['pdfLinks']>[number];dest:any}[]=[];
  let archive:AnnotationArchive|undefined;
  const attachment=(await pdf.getAttachments())?.get(ANNOTATION_ATTACHMENT);
  if(attachment){try{const content=attachment.content??await pdf.getAttachmentContent(ANNOTATION_ATTACHMENT);if(content){const value=JSON.parse(new TextDecoder().decode(content));if(value.format==='penbook-annotations'&&value.version===1&&Array.isArray(value.pages))archive=value;}}catch{/* Native PDF annotations remain available. */}}
  const resourceMap=new Map<string,string>();
  if(archive)for(const [id,r]of Object.entries(archive.resources??{})){if(r.type!=='image'||typeof r.data!=='string')continue;const dest=uid();resourceMap.set(id,dest);book.resources[dest]=r;}
  for(let i=0;i<pdf.numPages;i++){
    const source=await pdf.getPage(i+1);
    try{
      const vp=source.getViewport({scale:1}),p=newPage('blank');p.width=vp.width;p.height=vp.height;p.title=`${name.replace(/\.pdf$/i,'')} · ${i+1}`;p.background={resource:key,page:i};p.pdfLinks=[];p.pdfAnnotationIds=[];
      const text=await source.getTextContent();p.pdfText=text.items.filter((t):t is any=>'str'in t).map(t=>t.str).join(' ');
      for(const a of await source.getAnnotations()){
        if(a.annotationFlags&35)continue;
        if(a.subtype==='Popup')continue;
        const original=archive?.pages[i]?.annotations.find(v=>v.id===a.id&&v.contents===(a.contentsObj?.str??a.contents??'')&&v.rect.every((v,j)=>Math.abs(v-a.rect[j])<.01)&&matchesNative(v.native,a));
        if(a.annotationType===2){
          const [x1,y1]=vp.convertToViewportPoint(a.rect[0],a.rect[1]),[x2,y2]=vp.convertToViewportPoint(a.rect[2],a.rect[3]),link={x:Math.min(x1,x2),y:Math.min(y1,y2),w:Math.abs(x2-x1),h:Math.abs(y2-y1),url:linkUrl(a)}as NonNullable<Page['pdfLinks']>[number];
          if(!original){if(a.dest)pending.push({page:p,link,dest:a.dest});if(link.url||a.dest)p.pdfLinks.push(link);continue;}
        }
        let items=annotationItems(a,source);
        if(original){try{const wrapped=newBook();wrapped.pages[0].items=[clone(original.item)];items=parseBook(JSON.stringify(wrapped)).pages[0].items;const o=items[0],saved=archive!.pages[i];o.id=uid();o.x*=vp.width/saved.width;o.y*=vp.height/saved.height;o.w*=vp.width/saved.width;o.h*=vp.height/saved.height;if(o.resource)o.resource=resourceMap.get(o.resource);o.pdfAnnotationId=a.id;}catch{/* Fall back to standard annotation geometry. */}}
        if(!original&&a.subtype==='FreeText'&&items.length){const preview=await nativePreview(a,source,key,book),o=items[0];o.resource=preview.resource;bindNative(o,a,source,key);o.pdfNative!.baselineStyle=nativeTextStyle(o);}
        if(!items.length)items=[await nativePreview(a,source,key,book)];
        if(items.length){p.items.push(...items);p.pdfAnnotationIds.push(a.id);}
      }
      pages.push(p);
    }finally{source.cleanup();}
    if(i%10===0)await new Promise<void>(r=>setTimeout(r,0));
  }
  for(const {link,dest}of pending){const index=await destinationPage(pdf,dest);if(index!==undefined)link.page=pages[index]?.id;}
  const visit=async(nodes:any[],level=0)=>{for(const node of nodes){const index=await destinationPage(pdf,node.dest),p=index===undefined?undefined:pages[index];if(p){p.bookmark=true;(p.pdfBookmarks??=[]).push({title:node.title,level});p.outline??=node.title;}await visit(node.items??[],level+1);}};
  await visit(await pdf.getOutline()??[]);await pdf.cleanup();return pages;
}
