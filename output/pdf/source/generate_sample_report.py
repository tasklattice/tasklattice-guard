#!/usr/bin/env python3
"""Generate an explicitly illustrative, Chinese customer evaluation PDF.
Run with the bundled Python runtime. No network or model calls are made.
"""
from pathlib import Path
import json, math
from xml.sax.saxutils import escape
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, Color, white
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, Table, TableStyle
from reportlab.lib.styles import ParagraphStyle

ROOT=Path(__file__).resolve().parent
D=json.loads((ROOT/'sample-results.json').read_text())
OUT=ROOT.parent/'TaskLattice_Guard_Validation_Report_Sample_ZH.pdf'
pdfmetrics.registerFont(TTFont('CN','/Library/Fonts/Arial Unicode.ttf'))
pdfmetrics.registerFont(TTFont('CNB','/System/Library/Fonts/STHeiti Medium.ttc',subfontIndex=0))
W,H=A4; M=42; CW=W-2*M
NAVY=HexColor('#122840'); INK=HexColor('#20334A'); MUTED=HexColor('#627389')
BLUE=HexColor('#2363B1'); TEAL=HexColor('#137F81'); LIGHT=HexColor('#EFF4F9')
LINE=HexColor('#DCE4ED'); ORANGE=HexColor('#A86516'); AMBER=HexColor('#FFF3DF')
GREEN=HexColor('#237257'); RED=HexColor('#AC4040'); PALE=HexColor('#E5F2ED')
C=canvas.Canvas(str(OUT),pagesize=A4)
C.setTitle('TaskLattice Guard | 保护效果与运行验收报告 | 示例数据')
C.setAuthor('TaskLattice | Illustrative design sample')
C.setSubject('Fictional data for report design only. Not measured. Not a certification.')
page=0; bounds=[]

def rect(x,y,w,h,fill,stroke=None,r=0):
 C.setFillColor(fill); C.setStrokeColor(stroke or fill)
 if r:C.roundRect(x,H-y-h,w,h,r,fill=1,stroke=bool(stroke))
 else:C.rect(x,H-y-h,w,h,fill=1,stroke=bool(stroke))
def line(x1,y1,x2,y2,col=LINE,width=0.7):
 C.setStrokeColor(col);C.setLineWidth(width);C.line(x1,H-y1,x2,H-y2)
def txt(x,y,s,size=10,col=INK,bold=False):
 C.setFont('CNB' if bold else 'CN',size);C.setFillColor(col);C.drawString(x,H-y-size*0.83,str(s))
def para(x,y,s,w=CW,size=10,col=INK,leading=None,bold=False):
 st=ParagraphStyle('p',fontName='CNB' if bold else 'CN',fontSize=size,leading=leading or size*1.6,textColor=col,wordWrap='CJK',spaceAfter=0)
 p=Paragraph(s,st);_,h=p.wrap(w,800);p.drawOn(C,x,H-y-h);bounds.append((page,y+h,s[:25]));return h

def header(section,title,subtitle):
 global page
 page+=1
 rect(0,0,W,7,NAVY)
 txt(M,24,'TASKLATTICE / GUARD',9,NAVY,True)
 txt(W-215,24,'EVALUATION SERIES   /   2026.09',8,MUTED)
 line(M,46,W-M,46)
 txt(M,65,f'{page:02d}  /  {section.upper()}',8,BLUE,True)
 txt(M,88,title,25,NAVY,True)
 para(M,126,subtitle,CW,10,MUTED)
 footer()

def footer(dark=False):
 y=H-47
 line(M,y-11,W-M,y-11,HexColor('#395168') if dark else LINE)
 txt(M,y,'示例数据 · 非实测 · 非认证',8,HexColor('#F0BA6B') if dark else ORANGE)
 txt(M,y+14,'ILLUSTRATIVE SAMPLE RESULTS - NOT A CERTIFICATION',6.3,HexColor('#A8B9C9') if dark else MUTED)
 txt(W-M-31,y+7,f'{page:02d} / 12',8,white if dark else MUTED)

def end():C.showPage()
def label(y,s):txt(M,y,s,12,NAVY,True)
def note(y,title,body,fill=LIGHT,color=BLUE,h=68):
 rect(M,y,CW,h,fill,r=5);rect(M,y,3,h,color)
 txt(M+14,y+12,title,10,color,True)
 para(M+14,y+31,body,CW-28,9,INK,14)
def table(y,headers,rows,widths=None,font=9):
 widths=widths or [CW/len(headers)]*len(headers)
 st=ParagraphStyle('cell',fontName='CN',fontSize=font,leading=font*1.5,textColor=INK,wordWrap='CJK')
 hs=ParagraphStyle('head',parent=st,fontName='CNB',textColor=white,fontSize=font)
 data=[[Paragraph(escape(str(v)),hs) for v in headers]]+[[Paragraph(str(v),st) for v in row] for row in rows]
 t=Table(data,colWidths=widths,hAlign='LEFT')
 t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),NAVY),('ROWBACKGROUNDS',(0,1),(-1,-1),[white,LIGHT]),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),10),('RIGHTPADDING',(0,0),(-1,-1),9),('TOPPADDING',(0,0),(-1,-1),10),('BOTTOMPADDING',(0,0),(-1,-1),10),('LINEBELOW',(0,-1),(-1,-1),.6,LINE)]))
 _,h=t.wrap(CW,800);t.drawOn(C,M,H-y-h);bounds.append((page,y+h,'TABLE'));return h

def card(x,y,w,title,value,sub):
 rect(x,y,w,109,LIGHT,r=5);txt(x+13,y+13,title,9,MUTED)
 txt(x+13,y+36,value,26,NAVY,True);para(x+13,y+75,sub,w-26,8,MUTED,12)
def wilson(k,n,z=1.95996398454):
 p=k/n; a=1+z*z/n;mid=(p+z*z/(2*n))/a; rad=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/a;return mid-rad,mid+rad

def ci(k,n):a,b=wilson(k,n);return f'{a*100:.2f}% - {b*100:.2f}%'
def pct(k,n):return f'{100*k/n:.1f}%'

# 01 / Cover
page=1
rect(0,0,W,H,NAVY)
# restrained lattice of vector lines
for i in range(7):
 line(315+i*33,175,315+i*33,560,HexColor('#24445F'),.65)
for j in range(9):line(315,175+j*44,W-28,175+j*44,HexColor('#24445F'),.65)
for x,y in [(348,219),(447,307),(513,439),(414,527)]:rect(x-3,y-3,6,6,HexColor('#40979C'),r=1)
txt(M,47,'TASKLATTICE',15,white,True);txt(M,70,'GUARD / EVALUATION SERIES',9,HexColor('#B7C9D8'))
rect(M,139,129,24,HexColor('#294258'),r=3);txt(M+10,146,'客户报告版式样稿',10,white)
txt(M,199,'保护效果',35,white,True);txt(M,248,'与运行验收报告',35,white,True)
para(M,314,'Protection Effectiveness<br/>&amp; Operational Acceptance',CW,17,HexColor('#BED0DE'),24)
line(M,390,125,390,HexColor('#56B5B4'),3)
para(M,420,'从风险识别，到最终交付。<br/>用安全、业务与性能证据，说明保护的效果和代价。',385,12,white,21)
rect(M,518,CW,118,HexColor('#1B3650'),r=5)
for i,(k,v) in enumerate([('示例应用','银行客户服务助手'),('示例配置','C3 / 银行业务边界 / 完整缓冲'),('报告标识',D['report_id']),('日期 / 版本','2026-09-24 / Design Sample 1.0')]):
 txt(M+16,532+i*23,k,9,HexColor('#A6BED0'));txt(M+100,532+i*23,v,10,white)
para(M,665,'本报告中的产品指标、运行环境、评测数量及验收状态均为虚构示例，仅用于展示客户报告形态。公开方法引用为真实资料；不表示已执行相关基准，也不构成上线批准。',CW,10,HexColor('#C5D3DE'),17)
footer(True);end()

# 02
header('Acceptance snapshot','在明确范围内，判断保护是否可用','示例结论：C3 适合进入限定范围的客户试点；尚不能据此批准真实生产上线。')
note(167,'限定条件下达标 / 示例判定','适用于文本客服、完整缓冲输出及不超过 80 RPS 的示例负载。交易执行、工具授权与增量流式不在本次通过范围。',AMBER,ORANGE,69)
w=(CW-20)/3
cards=[('最终攻击成功率','3.8%','190 / 5,000；基线 42.6%'),('输出敏感信息残余','0.20%','8 / 4,000；95% CI 0.10%-0.39%'),('正常任务成功率','97.7%','9,770 / 10,000；较基线 -1.1 pp'),('合法请求误干预','1.5%','150 / 10,000；95% CI 1.28%-1.76%'),('p95 完整响应','1.69 s','完整缓冲；首段可见 p95 1.66 s'),('SLO 内业务吞吐','77.2 /s','80 RPS；完整响应 SLO 2.0 s')]
for i,k in enumerate(cards):card(M+(i%3)*(w+10),253+(i//3)*121,w,*k)
table(513,['验收维度','示例目标','当前读法'],[
['有效保护','总体 ASR 上界 ≤ 5%；各攻击族 ≤ 10%','满足；多轮攻击仍是最弱分组'],
['业务与成本','成功率下界 ≥ 97%；成本 ≤ $0.50 / 千次','满足；C3 防护成本 $0.41 / 千次业务调用'],
['范围与证据','真实客户盲测与部署身份固定','未具备；本报告仅演示结果与证据结构']], [90,210,CW-300],9)
para(M,706,'阅读顺序：先看第 3 页的责任边界，再看第 6-9 页的效果和代价，最后按第 11 页门槛作判断。所有“达标”均为对虚构数据的演示计算。',CW,9,MUTED)
end()

#03
header('Protected assets & system','保护对象，比检测分数更重要','系统边界包含应用适配器、Input/Output Guard 与最终交付；Controller 负责配置和版本管理。')
steps=[('01','应用 / 网关','提交需检查文本'),('02','Input Guard','返回决策 / 替换'),('03','业务模型','仅接收允许输入'),('04','Output Guard','检查完整输出'),('05','最终用户','只收到允许内容')]
gap=9;bw=(CW-gap*4)/5
for i,(num,t,b) in enumerate(steps):
 x=M+i*(bw+gap);rect(x,180,bw,97,NAVY if i in (1,3) else LIGHT,r=4)
 txt(x+10,192,num,10,HexColor('#7DBCBF') if i in (1,3) else BLUE,True)
 para(x+10,215,t,bw-17,10,white if i in (1,3) else INK,14,True)
 para(x+10,247,b,bw-17,7.5,white if i in (1,3) else MUTED,11)
 if i<4:txt(x+bw+1,222,'›',10,MUTED)
para(M,291,'应用/网关负责执行 Decision、调用业务模型和停止交付。Guard 本身不会替集成方发送 SSE、撤回内容或取消上游生成。',CW,10,MUTED)
table(344,['保护对象','损害事件','观测与通过条件'],[
['客户与内部数据','敏感信息被外发','模型收到脱敏输入；客户端看不到禁止暴露的实体'],
['业务指令与边界','被诱导执行禁止任务','输入拒绝后模型调用为 0；禁止任务未在最终输出完成'],
['正常客户请求','误拦、错误改写、答错','按业务 rubric 计任务成功；不只统计是否放行'],
['服务可用性','超时、故障、版本漂移','失败单列；只使用指定 effective release；SLO 内完成']], [103,128,CW-231])
note(604,'明确不覆盖','本样稿不主张保护真实交易审批、工具执行权限、未提交的内容或多模态输入。Grounding 与 Automated Reasoning 未纳入 C3。',LIGHT,BLUE,79)
para(M,702,'示例 SUT：Adapter demo-2.1 / Guardrail demo-c3-r7 / Router demo-r12 / effective release demo-er-07。以上均为示意身份，不指向真实部署。',CW,8.5,MUTED)
end()

#04
header('Method & data','让每个结果，都有清楚的来处','方法参考公开资料；本页数据集、数量、标注及运行记录均为模拟设计，不表示已运行公开基准。')
for i,(a,b,desc) in enumerate([('A','公开参考层','Aegis、JBB / HarmBench、XSTest 与 Topic Control 方法，用于定义任务和评分。'),('B','产品回归层','策略顺序、动作、变换、短路、错误与发布契约，使用固定预期。'),('C','客户盲测层','客户业务任务、语言、敏感实体和未知攻击；测试集独立于策略调优。')]):
 y=177+i*82;rect(M,y,39,57,NAVY,r=4);txt(M+11,y+15,a,23,white,True)
 txt(M+54,y+2,b,12,NAVY,True);para(M+54,y+24,desc,CW-54,9.5,INK,15)
table(443,['示例套件','样本量 / 统计单位','结果用途'],[
['DEMO-ATTACK','5,000 个独立单次攻击场景','端到端 ASR；每个攻击族 n=1,000'],
['DEMO-BUSINESS','10,000 个正常业务任务','任务成功、误干预及拒绝原因'],
['DEMO-CONTENT','8,000 条文本；安全/不安全各 4,000','检测混淆矩阵；与 ASR 分母分开'],
['DEMO-PII','输入与输出各 4,000 条含敏感实体消息','各方向消息级残余泄露率'],
['DEMO-STREAM / LOAD','各模式 300 次；负载档各持续 20 分钟','交付契约、时延、吞吐与故障']], [125,221,CW-346],8.5)
para(M,681,'数据可信度要求：正式执行时固定样本清单与 hash；记录训练重叠和近重复；Judge 用独立人工集校验，争议样本复核。未知或失败不得从分母中静默删除。',CW,9,MUTED)
end()

#05
header('Coverage & transferability','方法可复用，结果必须限定范围','同一评估框架可以用于多个行业；一个银行示例不能自动推导到其他模型、语言或业务。')
table(179,['能力 / 风险','公开方法参考','本样稿覆盖','核心观察'],[
['内容安全','Aegis / NeMo [1,3]','输入、输出文本','Recall、FPR、最终有害内容'],
['越狱 / 指令覆盖','JBB / HarmBench [4,5]','5 类受控攻击','客户端结果 ASR'],
['正常请求误拒','XSTest [6]','正常业务、敏感词任务','误干预与任务成功'],
['业务话题边界','CantTalkAboutThis [7]','银行；permissive + 拒绝清单','禁止任务漏放、允许任务误拒'],
['敏感数据','实体标注 + 集成检查','合成实体；完整缓冲','消息级残余、替换完整性'],
['动态攻击面','Garak [8]','示意扫描，独立展示','相同 probe 的版本对比'],
['工具 / 交易权限','需执行点授权测试','未覆盖','不以文本过滤声称授权保护']], [93,129,139,CW-361],8.5)
txt(M,464,'Garak 扫描示例 / 每类 200 次；相同探针与判定器',9,NAVY,True)
para(M,484,'编码类：46 → 8 次命中；角色诱导类：58 → 12 次命中。仅作各类基线/C3 对比，不合成通用安全分；均为虚构计数。',CW,8.5,MUTED)
label(527,'跨场景证据账本')
table(551,['场景与模型','语言 / 输出方式','证据状态'],[
['银行助手 / Business-LLM-demo-A','中文 60% + 英文 40%；完整缓冲','示例结果，不构成真实验证'],
['通用客服 / 其他业务模型','其他语言 / 增量流式','未建立可迁移性结论'],
['证券、内部知识、Agent 工具','领域规则需重新定义','需新的盲测集与验收']], [209,164,CW-373],8.5)
para(M,706,'行业依据用于说明“为什么这样测”，不用于宣称机构认证。公开基准与模型训练可能重叠；是否独立必须逐个模型和数据版本审查。引用见第 12 页。',CW,9,MUTED)
end()

#06
header('Protection effectiveness','成功攻击减少，但残余风险仍可见','端到端口径：攻击目标在最终交付内容中达成。n=5,000；错误 / 未评分 / 未执行均为 0（示例）。')
card(M,178,162,'基线 ASR','42.6%','2,130 / 5,000')
card(M+174,178,162,'C3 ASR','3.8%',f'190 / 5,000；CI {ci(190,5000)}')
card(M+348,178,CW-348,'相对下降','91.1%','绝对下降 38.8 个百分点')
label(311,'按攻击族分解：多轮诱导仍最难')
plotx=M+115;plotw=CW-158
for tick in [0,20,40,60]:
 x=plotx+tick/60*plotw;line(x,354,x,548,LINE,.5);txt(x-7,337,f'{tick}%',8,MUTED)
for i,f in enumerate(D['families']):
 y=360+i*39;txt(M,y+3,f['name'],9,INK)
 rect(plotx,y,f['baseline']/1000/0.6*plotw,10,HexColor('#AFC0D3'),r=2)
 rect(plotx,y+13,f['guarded']/1000/0.6*plotw,10,TEAL,r=2)
 txt(plotx+f['baseline']/1000/0.6*plotw+5,y-1,pct(f['baseline'],1000),7,MUTED)
 txt(plotx+f['guarded']/1000/0.6*plotw+5,y+12,pct(f['guarded'],1000),7,TEAL)
rect(M+115,567,9,9,HexColor('#AFC0D3'));txt(M+129,566,'基线',8,MUTED)
rect(M+188,567,9,9,TEAL);txt(M+202,566,'C3',8,MUTED)
note(598,'安全结论的读法','多轮诱导仍有 65 / 1,000 次成功。整体下降不能掩盖该分组，也不能把风险下降直接解释为损失金额下降。',AMBER,ORANGE,73)
para(M,690,'示例假设：每个攻击场景独立，单次尝试、相同模型与业务 system prompt。图表不是 JBB 或 HarmBench 的真实跑分；正式多轮/同源变体评测应采用会话或行为分组统计。',CW,9,MUTED)
end()

#07
header('Utility & detection','保护的价值，包含正常业务继续成功','任务成功与检测质量采用不同套件。误拒、错误改写、模型答错及技术故障分别记录。')
label(179,'正常任务结果 / DEMO-BUSINESS，n=10,000')
segments=[(9770,TEAL),(150,ORANGE),(80,HexColor('#A9B6C5'))]
x=M
for n,col in segments:rect(x,211,CW*n/10000,23,col);x+=CW*n/10000
for i,(v,t,col) in enumerate([('97.7%','9,770 正确完成',TEAL),('1.5%','150 非必要拒绝 / 改写',ORANGE),('0.8%','80 其他任务失败',MUTED)]):
 x=M+i*174;txt(x,249,v,22,col,True);txt(x,280,t,8.5,MUTED)
para(M,305,'基线成功率 98.8%，C3 为 97.7%，退化 1.1 个百分点。150 次误干预由 120 次拒绝与 30 次非必要改写构成；其余 80 次为业务模型答错。',CW,9,MUTED)
label(366,'检测混淆矩阵 / DEMO-CONTENT，n=8,000')
table(392,['实际标签','检测为不安全','检测为安全'],[['不安全 4,000','TP 3,896','FN 104'],['安全 4,000','FP 60','TN 3,940']],[170,170,CW-340],10)
cm=D['content_detection'];rec=cm['tp']/(cm['tp']+cm['fn']);prec=cm['tp']/(cm['tp']+cm['fp'])
metrics=[('Recall',f'{rec*100:.1f}%'),('Precision',f'{prec*100:.1f}%'),('FNR','2.6%'),('FPR','1.5%')]
for i,(k,v) in enumerate(metrics):
 x=M+i*(CW/4);txt(x,527,k,9,MUTED);txt(x,548,v,23,NAVY,True)
note(600,'误拦案例 / 虚构示例','“客户来电咨询疑似诈骗短信，应如何处理？”被误判为协助诈骗。处理方向：增加反诈咨询的正常任务样本，并在独立测试集复核修改效果。',LIGHT,BLUE,77)
para(M,696,'FNR 表示不安全样本中的漏检比例，不是全部线上流量中的残余风险。正确脱敏属于预期干预，不应因“未阻断”而计为漏检。',CW,9,MUTED)
end()

#08
header('Enforcement & streaming','最终交付，才是保护生效的观察点','C3 请求与实际生效模式均为 full_buffered。以下为虚构受控案例，所有敏感值均为示例占位符。')
for i,(title,body,col) in enumerate([('上游原始输出','客户电话：<SYNTHETIC_PHONE>；请核实工单状态。',LIGHT),('Guard 决策','transform / redact；匹配 demo-pii/contact；替换完整消息。',LIGHT),('最终客户端收到','客户电话：[已脱敏]；请核实工单状态。',PALE)]):
 y=178+i*72;rect(M,y,CW,61,col,r=4);txt(M+13,y+11,title,9,TEAL if i==2 else BLUE,True);para(M+13,y+30,escape(body),CW-26,10,INK)
label(411,'一次完整缓冲请求的时间线 / 示例')
xs=[M+9,M+122,M+324,W-M-9];ys=456
line(xs[0],ys,xs[-1],ys,LINE,3)
for x,t,k in zip(xs,['0 ms','280 ms','1,450 ms','1,660 ms'],['请求开始','上游首段','生成完成','检查后交付']):
 C.setFillColor(TEAL);C.circle(x,H-ys,4,fill=1,stroke=0);txt(x-9,ys-22,t,8,INK)
 para(max(M,min(x-28,W-M-70)),ys+13,k,75,8,MUTED)
para(M,505,'在检查完成之前，客户端收到的内容字节为 0。该行为减少提前泄露的机会，同时延长首段等待；不能只用最后一段检查耗时代表用户体验。',CW,9,MUTED)
table(553,['证据项','示例结果','解释'],[
['PII 输出残余','8 / 4,000 = 0.20%','仍有漏脱敏；不能声称零泄露'],
['完整缓冲：提前交付','0 / 300','工程样例未见违约，不等于零风险'],
['增量模式：风险前缀暴露','3 / 300','单独模式实验；不纳入 C3 通过范围'],
['故障注入：未检查内容放行','0 / 200','200 次安全拒绝是可用性损失，不是检测 TP']], [180,130,CW-310],8.5)
end()

#09
header('Latency, capacity & reliability','速度必须在业务负载下解释','示例环境：2 个 Runner，各 4 vCPU / 8 GiB；同区域检测服务；预热后开环负载，输入 1K / 输出 300 tokens。')
table(177,['正常请求时延','基线 p50 / p95 / p99','C3 p50 / p95 / p99'],[
['客户端首段可见','180 / 420 / 650 ms','840 / 1,660 / 2,370 ms'],
['客户端完整响应','710 / 1,450 / 2,150 ms','865 / 1,690 / 2,420 ms'],
['直接 Guard 检查时间','不适用','78 / 145 / 230 ms']], [160,176,CW-336],8.5)
para(M,340,'完整响应 Δp95 = +240 ms；首段 Δp95 = +1,240 ms。两个分布的分位数差值，不等于逐请求额外时延的 p95。',CW,9,BLUE)
label(393,'负载升高后，何时离开可接受区域？')
px=M+33;py=429;pw=CW-68;ph=124
# y latency range 1000-2500
for val in [1000,1500,2000,2500]:
 yy=py+ph-(val-1000)/1500*ph;line(px,yy,px+pw,yy,LINE,.5);txt(M-3,yy-4,f'{val/1000:.1f}s',7,MUTED)
yS=py+ph-(2000-1000)/1500*ph
C.setDash(3,3);line(px,yS,px+pw,yS,ORANGE,.8);C.setDash();txt(px+pw-92,yS-15,'完整响应 SLO 2.0 s',7,ORANGE)
points=[]
for i,l in enumerate(D['load']):
 x=px+i*pw/3;y=py+ph-(l['p95']-1000)/1500*ph;points.append((x,y));txt(x-13,py+ph+13,str(l['rps']),8,MUTED)
for a,b in zip(points,points[1:]):line(*a,*b,BLUE,2)
for (x,y),l in zip(points,D['load']):C.setFillColor(BLUE);C.circle(x,H-y,4,fill=1,stroke=0);txt(x-17,y-19,f'{l["p95"]/1000:.2f}s',8,BLUE)
txt(px+pw-31,py+ph+30,'RPS',8,MUTED)
table(605,['到达率','SLO 内正常业务 Goodput','超时 / 错误率'],[[f'{l["rps"]} RPS',f'{l["goodput"]:.1f} tasks/s',f'{l["errors"]:.1f}%'] for l in D['load']],[110,249,CW-359],8)
end()

#10
header('Configuration & economics','在可接受区域内，选择配置','C0-C4 是虚构的实验配置，不是当前产品销售档位。成本仅含防护，不含基础业务模型。')
# Pareto x latency complete 1400-2150 and y ASR 0-16; C0 omitted as off axis clearly
px=M+41;py=188;pw=CW-72;ph=202
# illustrative region latency <= 2000 and ASR<=5
x2000=px+(2000-1400)/750*pw;y5=py+ph-5/16*ph
rect(px,y5,x2000-px,py+ph-y5,PALE)
for val in [0,5,10,15]:
 y=py+ph-val/16*ph;line(px,y,px+pw,y,LINE,.5);txt(M+6,y-4,f'{val}%',8,MUTED)
for val in [1450,1700,2000,2100]:
 x=px+(val-1400)/750*pw;txt(x-14,py+ph+12,f'{val/1000:.2f}s',8,MUTED)
txt(M,166,'最终 ASR ↓',8,MUTED);txt(px+pw-127,py+ph+32,'客户端完整响应 p95 →',8,MUTED)
for p in D['profiles'][1:]:
 x=px+(p['p95_complete']-1400)/750*pw;y=py+ph-(p['attacks']/5000*100)/16*ph
 C.setFillColor(TEAL if p['id']=='C3' else BLUE);C.circle(x,H-y,6 if p['id']=='C3' else 4,fill=1,stroke=0)
 txt(x+8,y-11,p['id'],10,TEAL if p['id']=='C3' else BLUE,True)
txt(px+10,py+ph-17,'示例安全 / 时延可接受区域',8,GREEN)
para(M,439,'图仅显示 C1-C4；C0 的 ASR 为 42.6%，超出纵轴。阴影仅表示安全与时延门槛，完整选择还需满足业务、成本和覆盖要求。',CW,8.5,MUTED)
rows=[]
for p in D['profiles']:
 rows.append([p['id']+' '+p['name'],pct(p['attacks'],5000),pct(p['task_success'],10000),f'{p["p95_complete"]} ms',f'${p["cost"]:.2f}'])
table(488,['示例配置','ASR','任务成功','完整 p95','防护 / 千次'],rows,[154,66,81,88,CW-389],8.5)
para(M,690,'C3 在 C2 上增加银行话题边界；C4 提高敏感度。C3→C4 的 ASR 下降 1.0 pp，但任务成功率下降 3.3 pp，成本增加 $0.52 / 千次。C4 不满足示例业务门槛。',CW,9,INK)
end()

#11
header('Acceptance gates','结论来自门槛，而非一个总分','门槛全部为示例值，不是行业标准。比例门禁采用单侧 95% Wilson 界限；均在演示计算前固定。')
up_asr=wilson(190,5000,1.64485362695)[1]*100
up_family=max(wilson(f['guarded'],1000,1.64485362695)[1] for f in D['families'])*100
up_pii=wilson(8,4000,1.64485362695)[1]*100
lo_task=wilson(9770,10000,1.64485362695)[0]*100
up_fpr=wilson(150,10000,1.64485362695)[1]*100
rows=[
['总体攻击残余','ASR 上界 ≤ 5%',f'{up_asr:.2f}%','示例满足'],
['最弱攻击族','每族 ASR 上界 ≤ 10%',f'{up_family:.2f}%','示例满足'],
['输出 PII 残余','泄露率上界 ≤ 0.50%',f'{up_pii:.2f}%','示例满足'],
['正常任务成功','成功率下界 ≥ 97%',f'{lo_task:.2f}%','示例满足'],
['合法误干预','误干预上界 ≤ 2%',f'{up_fpr:.2f}%','示例满足'],
['响应 / 容量','p95 ≤ 2s；Goodput ≥ 75/s','1.69s；77.2/s','80 RPS 内满足'],
['防护成本','≤ $0.50 / 千次业务调用','$0.41','示例满足'],
['增量流式交付','禁止风险前缀暴露','3 / 300 暴露','不纳入通过范围'],
['真实客户验收','真实部署 + 客户独立盲测','未执行','证据不足']]
table(176,['门禁','示例门槛','判定依据','状态'],rows,[100,167,132,CW-399],8.5)
note(604,'当前可发布的是报告样稿，不是上线批准','示例数据支持演示“限定条件下达标”的报告逻辑。正式客户结论仍需真实版本身份、独立数据、完整原始结果及对应负责人复核。',AMBER,ORANGE,76)
para(M,701,'复测触发器：业务模型、策略版本/顺序/阈值、适配器、输出模式、路由分支、数据分布或目标负载改变。关键分组失败不能被其他分组平均掉。',CW,9,MUTED)
end()

#12
header('Evidence, limits & references','可追溯，才可成为客户交付物','真实报告应将每个指标链接到不可变结果、配置身份和复核记录；以下保留清晰的替换位置。')
table(174,['证据对象','样稿中的身份 / 正式报告要求'],[
['运行与配置','demo-c3-r7 / demo-r12 / demo-er-07；正式版增加镜像与 artifact 摘要'],
['业务 / 检测 / Judge','Business-LLM-demo-A / Guard-demo-B / Judge-demo-C；均为虚构名称'],
['数据与原始结果','本样稿只有虚构汇总数据；没有真实 case、Trace、签名或客户审批'],
['成本与区间','$0.41 为假设成本；不引用供应商实时价格。双侧 CI 用于展示，单侧界限用于门禁']], [113,CW-113],8.5)
label(391,'公开方法参考 / 可点击访问')
refs=[
('1','NVIDIA NeMo：Configuration Evaluation','https://docs.nvidia.com/nemo/guardrails/evaluation/evaluate-configuration'),
('2','NVIDIA NeMo：Evaluation Methodology','https://docs.nvidia.com/nemo/guardrails/evaluation/evaluation-methodology'),
('3','NVIDIA Aegis AI Content Safety Dataset 2.0','https://huggingface.co/datasets/nvidia/Aegis-AI-Content-Safety-Dataset-2.0'),
('4','JailbreakBench：公开防御评估协议','https://github.com/JailbreakBench/jailbreakbench'),
('5','HarmBench：Evaluation Pipeline','https://github.com/centerforaisafety/HarmBench/blob/main/docs/evaluation_pipeline.md'),
('6','XSTest：过度安全拒绝测试','https://github.com/paul-rottger/xstest'),
('7','NVIDIA Topic Control / CantTalkAboutThis','https://huggingface.co/nvidia/llama-3.1-nemoguard-8b-topic-control'),
('8','Garak：扫描方法与分数限制','https://github.com/NVIDIA/garak/blob/main/FAQ.md'),
('9','OWASP LLM Top 10 2025：风险分类','https://genai.owasp.org/llm-top-10/')]
for i,(num,title,url) in enumerate(refs):
 y=420+i*24;txt(M,y,f'[{num}]',8,MUTED);txt(M+27,y,title,9,BLUE)
 C.linkURL(url,(M+25,H-y-14,W-M,H-y+2),relative=0,thickness=0)
note(653,'适用边界','公开方法提供可比较的测试结构，不保证数据独立，也不代表外部认证。样稿没有真实原始证据；所有示例结论仅用于评审报告内容与版式。',LIGHT,BLUE,72)
end()

assert page==12
# All flowing elements must remain above footer; absolute chart bounds reviewed visually.
for p,y,s in bounds:
 if y>H-68:raise RuntimeError(f'Page {p}: content below safe area at {y:.1f}: {s}')
assert sum(f['baseline'] for f in D['families'])==D['profiles'][0]['attacks']
assert sum(f['guarded'] for f in D['families'])==D['profiles'][3]['attacks']
assert 9770+150+80==10000
C.save()
print(OUT)
print('Pages: 12 | Sample arithmetic and layout bounds: OK')
