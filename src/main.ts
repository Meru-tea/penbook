import { Plugin, PluginSettingTab, Setting, Notice, TFile, normalizePath, Menu, Modal } from 'obsidian';
import { newBook, newPage, Notebook, Paper, Pen, InkProfile, clone, parseBook, normalizeInfinitePaper } from './model';
import { notebookWizard, PAPER_NAMES, coverPreview, paperPreview } from './templates';
import { PRESET_COLORS } from './palette';
import { form, pickFile } from './dialogs';
import { PenbookView, VIEW_TYPE } from './view';
import { registerIcons } from './icons';
import { installTooltips } from './tooltips';
import { SHORTCUTS, shortcutHint } from './shortcuts';
import { SelectionClipboard } from './selection-clipboard';
import { PenFavorite, normalizePenFavorites } from './pen-favorites';
import { PenbookEmbedManager } from './embed';
import { LibraryIndex } from './library-index';

export interface Preferences {
  folder:string; paper:Paper; penColor:string; penWidth:number; pressure:number; fingerInk:boolean;
  leftHanded:boolean; toolbarBottom:boolean; language:'zh'; exportScale:number; eraser:'stroke'|'pixel';
  customColors:string[];presetColors:string[];
  colorHistory:string[]; inkProfiles:Partial<Record<Pen,InkProfile>>; eraserPrecision:'fine'|'standard'; eraserOnly:'all'|'highlighter'|'tape'; eraserAutoPrevious:boolean;
  penEnabled:boolean; scrollDirection:'vertical'|'horizontal'; showResolved:boolean;
  penFavorites?:PenFavorite[]; gridSnap?:boolean;
}
export const DEFAULTS:Preferences={folder:'手写笔记',paper:'ruled',penColor:'#000000',penWidth:3,pressure:1,fingerInk:false,leftHanded:false,toolbarBottom:false,language:'zh',exportScale:1.5,eraser:'stroke',customColors:[],presetColors:PRESET_COLORS,colorHistory:[],inkProfiles:{},eraserPrecision:'standard',eraserOnly:'all',eraserAutoPrevious:false,penEnabled:true,scrollDirection:'vertical',showResolved:false,penFavorites:normalizePenFavorites(),gridSnap:false};

export default class PenbookPlugin extends Plugin {
  settings:Preferences={...DEFAULTS};
  selectionClipboard:SelectionClipboard|null=null;
  embedManager?:PenbookEmbedManager;
  libraryIndex=new LibraryIndex();
  async onload(){
    registerIcons();
    this.register(installTooltips());
    this.settings={...DEFAULTS,...await this.loadData()};
    this.settings.presetColors=[...new Set([...this.settings.presetColors,...this.settings.customColors])];this.settings.inkProfiles={...this.settings.inkProfiles};this.settings.colorHistory=[...this.settings.colorHistory];
    this.settings.penFavorites=normalizePenFavorites(this.settings.penFavorites);this.settings.gridSnap=Boolean(this.settings.gridSnap);
    await this.loadLibraryIndex();
    this.registerView(VIEW_TYPE,leaf=>new PenbookView(leaf,this));this.registerExtensions(['penbook'],VIEW_TYPE);
    this.addRibbonIcon('pb-pen','新建手写笔记本',()=>void this.createNotebook());
    this.addCommand({id:'new-notebook',name:'新建手写笔记本',callback:()=>void this.createNotebook()});
    this.addCommand({id:'new-infinite-notebook',name:'新建无界笔记',callback:()=>void this.createInfiniteNotebook()});
    this.addCommand({id:'library',name:'笔记本列表',callback:()=>new Library(this).open()});
    this.addCommand({id:'import-pdf',name:'从 PDF 创建手写笔记本',callback:()=>void this.fromPdf()});
    for(const [id,label] of SHORTCUTS){
      const hint=shortcutHint(id),name=hint?`${label}（${hint}）`:label;
      this.addCommand({id,name,checkCallback:checking=>{const v=this.app.workspace.getActiveViewOfType(PenbookView),target=document.activeElement?.closest('.prompt')?null:document.activeElement;if(!v||!v.canShortcut(id,target))return false;if(!checking)void v.executeShortcut(id,false,target).catch(error=>{console.error('Penbook',error);new Notice(String(error));});return true;}});
    }
    this.registerEvent(this.app.workspace.on('file-menu',(menu,file)=>{
      if(file instanceof TFile && file.extension==='pdf')menu.addItem(i=>i.setTitle('用 Penbook 批注 PDF').setIcon('pb-pen').onClick(()=>void this.fromPdf(file)));
      if(file instanceof TFile && file.extension==='penbook')menu.addItem(i=>i.setTitle('复制笔记本').setIcon('pb-copy').onClick(()=>void this.duplicate(file)));
    }));
    this.registerObsidianProtocolHandler('penbook',async params=>{
      if(params.vault&&params.vault!==this.app.vault.getName())return;
      const file=this.app.vault.getAbstractFileByPath(normalizePath(params.file??''));if(!(file instanceof TFile)||file.extension!=='penbook')return;
      const leaf=this.app.workspace.getLeaf(false);await leaf.openFile(file);
      if(leaf.view instanceof PenbookView){
        if(params.bookmark)leaf.view.goToBookmarkId(params.bookmark);
        else if(params.page)leaf.view.goToId(params.page);
      }
    });
    this.embedManager=new PenbookEmbedManager(this);
    this.embedManager.register(this);
    this.registerEvent(this.app.vault.on('modify',file=>{if(file instanceof TFile&&file.extension==='penbook')this.libraryIndex.invalidate(file.path);}));
    this.registerEvent(this.app.vault.on('delete',file=>{if(file instanceof TFile&&file.extension==='penbook')this.libraryIndex.invalidate(file.path);}));
    this.registerEvent(this.app.vault.on('rename',(file,oldPath)=>{if(file instanceof TFile){if(file.extension==='penbook')this.libraryIndex.rename(oldPath,file.path);else if(oldPath.endsWith('.penbook'))this.libraryIndex.invalidate(oldPath);}}));
    this.addSettingTab(new PenbookSettings(this));
  }
  onunload(){
    void this.embedManager?.unload();
    this.libraryIndex.clear();
  }
  private libraryIndexPath(){return normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/library-index.json`);}
  async loadLibraryIndex(){
    try{
      const path=this.libraryIndexPath();
      await this.libraryIndex.load(async()=>{
        if(!await this.app.vault.adapter.exists(path))return null;
        return await this.app.vault.adapter.read(path);
      });
    }catch{/* Fallback cleanly to memory-only if adapter fails. */}
  }
  async saveLibraryIndex(){
    try{
      const path=this.libraryIndexPath();
      await this.libraryIndex.save(data=>this.app.vault.adapter.write(path,data));
    }catch{/* Fallback cleanly to memory-only if adapter fails. */}
  }
  asset(path:string){const url=this.app.vault.adapter.getResourcePath(normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/${path}`));return path.endsWith('/')?url.split('?')[0].replace(/\/?$/,'/'):url;}
  async saveSettings(){await this.saveData(this.settings);}
  async folder(path:string){const p=normalizePath(path);if(p&&p!== '/'&&!await this.app.vault.adapter.exists(p))await this.app.vault.createFolder(p);return p==='/'?'':p;}
  async unique(path:string){let p=normalizePath(path),i=1;const dot=p.lastIndexOf('.');while(await this.app.vault.adapter.exists(p)){p=`${path.slice(0,dot)} ${i++}${path.slice(dot)}`;}return p;}
  async writeBinary(name:string,bytes:Uint8Array){
    const base=await this.folder(`${this.settings.folder}/导出`),path=await this.unique(`${base}/${name}`);
    const data=new Uint8Array(bytes).buffer;await this.app.vault.createBinary(path,data);new Notice(`已保存：${path}`);return path;
  }
  async createNotebook(title?:string,book?:Notebook){
    if(!title){const draft=await notebookWizard(this.app,this.settings.paper);if(!draft)return;book=draft;title=draft.title;}
    const safe=title.replace(/[\\/:*?"<>|#\[\]]/g,'-'),folder=await this.folder(this.settings.folder);
    const path=await this.unique(`${folder?folder+'/':''}${safe}.penbook`);const file=await this.app.vault.create(path,JSON.stringify(book??newBook(title,this.settings.paper)));
    const leaf=this.app.workspace.getLeaf(false);await leaf.openFile(file);return leaf.view instanceof PenbookView?leaf.view:undefined;
  }
  async createInfiniteNotebook(){
    const draft=await notebookWizard(this.app,normalizeInfinitePaper(this.settings.paper),'infinite');
    if(!draft)return;
    return this.createNotebook(draft.title,draft);
  }
  async duplicate(file:TFile){const b=parseBook(await this.app.vault.read(file));b.title+=' 副本';b.created=new Date().toISOString();await this.createNotebook(b.title,b);}
  async fromPdf(file?:TFile){const pdf=file??await pickFile(this.app,f=>f.extension==='pdf','选择库中的 PDF');if(!pdf)return;const view=await this.createNotebook(pdf.basename);if(view)await view.importVaultFile(pdf,true);}
}
export const PAPERS=PAPER_NAMES;

class Library extends Modal {
  constructor(private plugin:PenbookPlugin){super(plugin.app);}
  async onOpen(){
    this.titleEl.setText('Penbook · 笔记本');const search=this.contentEl.createEl('input',{attr:{placeholder:'搜索名称、标签、书签、页面内容…',type:'search'}});search.addClass('pb-library-search');
    const list=this.contentEl.createDiv('pb-library');
    const files=this.app.vault.getFiles().filter(f=>f.extension==='penbook').sort((a,b)=>b.stat.mtime-a.stat.mtime);
    const fileByPath=new Map(files.map(f=>[f.path,f]));
    const entries=await this.plugin.libraryIndex.getEntries(files,file=>this.app.vault.read(file));
    if(this.plugin.libraryIndex.dirty)void this.plugin.saveLibraryIndex();
    const draw=()=>{list.empty();const query=search.value.toLowerCase();for(const entry of entries){if(query&&!entry.searchText.includes(query))continue;
      const card=list.createEl('button',{cls:'pb-library-card'});const cover=card.createDiv({cls:'pb-book-cover'});
      if(entry.isInfinite){
        cover.addClass('pb-book-cover-infinite');
        if(entry.hasCover!==false)coverPreview(cover,entry);else paperPreview(cover,{...newPage(entry.firstPagePaper),color:entry.firstPageColor,spacing:entry.firstPageSpacing},true);
        cover.createSpan({cls:'pb-infinite-badge',text:'∞ 无界'});
      }else{
        if(entry.hasCover!==false)coverPreview(cover,entry);else cover.style.background=entry.firstPageColor;
      }
      card.createEl('strong',{text:entry.title});
      card.createEl('small',{text:entry.isInfinite?`无界笔记${entry.bookmarkCount?` · ${entry.bookmarkCount} 个书签`:''} · ${entry.path}`:`${entry.pageCount} 页 · ${entry.path}`});
      card.onclick=async()=>{const file=fileByPath.get(entry.path);this.close();if(file)await this.app.workspace.getLeaf(false).openFile(file);};}
      if(!list.children.length)list.createEl('p',{text:'没有匹配的笔记本。使用左侧钢笔按钮新建。'});
    };search.oninput=draw;draw();
  }
}
class PenbookSettings extends PluginSettingTab {
  constructor(private plugin:PenbookPlugin){super(plugin.app,plugin);}
  display(){const el=this.containerEl;el.empty();new Setting(el).setName('Penbook 手写笔记').setHeading();
    new Setting(el).setName('新笔记本文件夹').addText(t=>t.setValue(this.plugin.settings.folder).onChange(async v=>{this.plugin.settings.folder=normalizePath(v||'手写笔记');await this.plugin.saveSettings();}));
    new Setting(el).setName('默认纸张').addDropdown(d=>d.addOptions(PAPERS).setValue(this.plugin.settings.paper).onChange(async v=>{this.plugin.settings.paper=v as Paper;await this.plugin.saveSettings();}));
    new Setting(el).setName('默认墨水颜色').addColorPicker(c=>c.setValue(this.plugin.settings.penColor).onChange(async v=>{this.plugin.settings.penColor=v;await this.plugin.saveSettings();}));
    new Setting(el).setName('默认笔宽').addSlider(s=>s.setLimits(1,20,1).setValue(this.plugin.settings.penWidth).setDynamicTooltip().onChange(async v=>{this.plugin.settings.penWidth=v;await this.plugin.saveSettings();}));
    new Setting(el).setName('压感响应').setDesc('小于 1 时轻触更粗，大于 1 时需要更大压力。').addSlider(s=>s.setLimits(.3,2,.1).setValue(this.plugin.settings.pressure).setDynamicTooltip().onChange(async v=>{this.plugin.settings.pressure=v;await this.plugin.saveSettings();}));
    for(const [key,name,desc] of [['fingerInk','允许手指书写','关闭时手指只负责平移和双指缩放，S Pen 与鼠标负责书写。'],['leftHanded','左手布局','将页面导航放在右侧。'],['toolbarBottom','工具栏放在底部','适合平板横屏书写。']] as const)new Setting(el).setName(name).setDesc(desc).addToggle(t=>t.setValue(this.plugin.settings[key]).onChange(async v=>{this.plugin.settings[key]=v;await this.plugin.saveSettings();}));
    new Setting(el).setName('画布快捷键').setHeading();
    el.createEl('p',{text:'快捷键仅在 Penbook 画布中生效；输入文字时保留原生编辑快捷键。Mod 在 macOS 上为 Cmd，其他平台为 Ctrl。可在 Obsidian 的快捷键设置中搜索 Penbook，为以下命令另绑按键。'});
    const shortcuts=el.createEl('table'),head=shortcuts.createEl('thead').createEl('tr');head.createEl('th',{text:'操作'});head.createEl('th',{text:'默认按键'});const body=shortcuts.createEl('tbody');for(const [,name,keys]of SHORTCUTS){const row=body.createEl('tr');row.createEl('td',{text:name});row.createEl('td',{text:keys.join(' / ')||'可在快捷键设置中绑定'});}
    el.createEl('p',{text:'方向键移动 1 像素，Shift + 方向键移动 10 像素。复制或剪切后可切换到另一本 Penbook 粘贴选区。'});
    el.createEl('p',{text:'运行时完全本地。OCR、手写转文本与识别搜索暂未实现；同步、录音与窗口管理不属于插件范围。'});
  }
}
