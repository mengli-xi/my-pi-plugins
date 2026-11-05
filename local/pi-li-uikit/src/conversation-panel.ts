import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { panelFooterRule } from "pi-li-uikit/panel-footer";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

export interface ConversationPanelSnapshot {
	/** Breadcrumb/title shown in the shared accent rule. */
	title: string;
	/** Native Pi conversation components in transcript order. */
	content: Component | readonly Component[];
	/** Stable revision used by consumers for their own component cache. */
	revision: string | number;
	emptyText?: string;
}
export interface ConversationPanelOptions {
	tui: TUI;
	theme: Theme;
	getSnapshot(): ConversationPanelSnapshot;
	onBack(): void;
	onClose(): void;
	/** Domain shortcuts such as message/follow-up. Return true when consumed. */
	onInput?(data: string): boolean;
	footerHints?:readonly string[]|(()=>readonly string[]);
	mouseScrollLines?: number;
}

function titleRule(theme:Theme,title:string,width:number):string{const label=truncateToWidth(` ${title} `,Math.max(1,width-4),"…");return`${theme.fg("accent","──")}${theme.fg("accent",theme.bold(label))}${theme.fg("accent","─".repeat(Math.max(0,width-2-visibleWidth(label))))}`;}
function renderContent(content:Component|readonly Component[],width:number):string[]{if(!Array.isArray(content))return(content as Component).render(width);const container=new Container();for(const component of content)container.addChild(component);return container.render(width);}

/**
 * UIKit viewport for a read-only Pi conversation.
 *
 * The caller supplies native Pi message/tool components; this component owns only
 * the shared panel frame, viewport, follow-newest state and keyboard/mouse scroll.
 */
export class ConversationPanel implements Component,Focusable{
	readonly wantsMouse=true;
	private readonly options:ConversationPanelOptions;
	private _focused=false;
	private availableHeight:number|undefined;
	private scrollOffset=0;
	private bodyRows=1;
	private maxOffset=0;
	private follow=true;
	private disposed=false;
	constructor(options:ConversationPanelOptions){this.options=options;}
	get focused():boolean{return this._focused;}
	set focused(value:boolean){this._focused=value;}
	get following():boolean{return this.follow;}
	get offset():number{return this.scrollOffset;}
	setAvailableHeight(rows:number):void{if(Number.isFinite(rows)&&rows>0)this.availableHeight=Math.floor(rows);}
	render(width:number):string[]{const safeWidth=Math.max(20,width),rows=Math.max(4,Math.min(this.options.tui.terminal.rows,this.availableHeight??this.options.tui.terminal.rows));const snapshot=this.options.getSnapshot();let body=renderContent(snapshot.content,safeWidth);if(body.length===0)body=[this.options.theme.fg("muted",snapshot.emptyText??"No conversation entries.")];this.bodyRows=Math.max(1,rows-3);this.maxOffset=Math.max(0,body.length-this.bodyRows);if(this.follow)this.scrollOffset=this.maxOffset;else this.scrollOffset=Math.max(0,Math.min(this.scrollOffset,this.maxOffset));const lines=[titleRule(this.options.theme,snapshot.title,safeWidth),"",...body.slice(this.scrollOffset,this.scrollOffset+this.bodyRows)];while(lines.length<rows-1)lines.push("");const hints=typeof this.options.footerHints==="function"?this.options.footerHints():this.options.footerHints;lines.push(panelFooterRule(this.options.theme,safeWidth,hints??["↑/↓ scroll · PgUp/PgDn · g/G · Esc back · Ctrl+C close","↑/↓ · g/G · Esc back","Esc back"]));return lines.slice(0,rows).map(line=>truncateToWidth(line,safeWidth,"…"));}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this._focused || this.disposed) return undefined;
		if (event.type !== "wheel") return undefined;
		this.manualScroll(Math.sign(event.wheelDelta ?? 0) * (this.options.mouseScrollLines ?? 3));
		return { handled: true };
	}
	handleInput(data:string):void{if(!this._focused||this.disposed)return;if(matchesKey(data,Key.ctrl("c"))){this.close();return;}if(matchesKey(data,Key.escape)){this.options.onBack();return;}if(this.options.onInput?.(data)){this.options.tui.requestRender();return;}const page=Math.max(1,this.bodyRows);if(matchesKey(data,Key.up)||data==="k")this.manualScroll(-1);else if(matchesKey(data,Key.down)||data==="j")this.manualScroll(1);else if(matchesKey(data,Key.pageUp)||matchesKey(data,Key.ctrl("b")))this.manualScroll(-page);else if(matchesKey(data,Key.pageDown)||matchesKey(data,Key.ctrl("f")))this.manualScroll(page);else if(matchesKey(data,Key.ctrl("u")))this.manualScroll(-Math.ceil(page/2));else if(matchesKey(data,Key.ctrl("d")))this.manualScroll(Math.ceil(page/2));else if(matchesKey(data,Key.home)||data==="g"){this.follow=false;this.scrollOffset=0;this.options.tui.requestRender();}else if(matchesKey(data,Key.end)||data==="G"){this.follow=true;this.scrollOffset=this.maxOffset;this.options.tui.requestRender();}}
	invalidate():void{}
	dispose():void{this.disposed=true;}
	private manualScroll(delta:number):void{this.follow=false;this.scrollOffset=Math.max(0,Math.min(this.maxOffset,this.scrollOffset+delta));if(delta>0&&this.scrollOffset>=this.maxOffset)this.follow=true;this.options.tui.requestRender();}
	private close():void{if(this.disposed)return;this.disposed=true;this.options.onClose();}
}
