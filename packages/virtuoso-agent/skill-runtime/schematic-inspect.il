; Read-only, structured schematic inspection for virtuoso-agent.
; Loaded only by the schematic inspect workflow after bridge.il.

procedure(vaSchematicJsonEscape(value)
    let((text escaped index char)
        text = if(value then
            if(stringp(value) then sprintf(nil "%s" value) else sprintf(nil "%L" value))
        else
            ""
        )
        escaped = ""
        for(index 1 strlen(text)
            char = substring(text index 1)
            escaped = strcat(
                escaped
                cond(
                    ((char == "\\") "\\\\")
                    ((char == "\"") "\\\"")
                    ((char == "\n") "\\n")
                    ((char == "\r") "\\r")
                    ((char == "\t") "\\t")
                    (t char)
                )
            )
        )
        escaped
    )
)

procedure(vaSchematicJsonString(value)
    strcat("\"" vaSchematicJsonEscape(value) "\"")
)

procedure(vaSchematicJsonList(value)
    let((items separator)
        items = ""
        separator = ""
        foreach(item value
            items = strcat(items separator vaSchematicJsonValue(item))
            separator = ","
        )
        strcat("[" items "]")
    )
)

procedure(vaSchematicJsonValue(value)
    cond(
        ((null value) "null")
        ((eq value t) "true")
        ((stringp value) vaSchematicJsonString(value))
        ((numberp value) sprintf(nil "%L" value))
        ((listp value) vaSchematicJsonList(value))
        (t vaSchematicJsonString(sprintf(nil "%L" value)))
    )
)

procedure(vaSchematicJsonBoolean(value)
    if(value then "true" else "false")
)

procedure(vaSchematicCount(items)
    let((count)
        count = 0
        foreach(item items count = count + 1)
        count
    )
)

procedure(vaSchematicText(value)
    if(value then
        if(stringp(value) then value else sprintf(nil "%L" value))
    else
        ""
    )
)

procedure(vaSchematicWidth(value)
    if(numberp(value) && value > 0 then value else 1)
)

procedure(vaSchematicParameterValue(param)
    let((value)
        value = param~>value
        if(null(value) then param~>defValue else value)
    )
)

procedure(vaSchematicMeaningful(value)
    if(value then
        if(stringp(value) then strlen(value) > 0 else t)
    else
        nil
    )
)

procedure(vaSchematicFindParameter(cdf parameterName)
    let((found)
        found = nil
        when(cdf
            foreach(param cdf~>parameters
                when(param~>name == parameterName found = param)
            )
        )
        found
    )
)

procedure(vaSchematicNormalizeLabelParameterName(parameterName)
    if(
        stringp(parameterName) &&
        strlen(parameterName) > 1 &&
        substring(parameterName 1 1) == "-"
    then
        substring(parameterName 2 strlen(parameterName) - 1)
    else
        parameterName
    )
)

procedure(vaSchematicAddParameterName(names cdf parameterName)
    let((param normalizedName)
        normalizedName = vaSchematicNormalizeLabelParameterName(parameterName)
        param = vaSchematicFindParameter(cdf normalizedName)
        if(
            param &&
            vaSchematicMeaningful(vaSchematicParameterValue(param)) &&
            !member(normalizedName names)
        then
            append(names list(normalizedName))
        else
            names
        )
    )
)

procedure(vaSchematicPropertyCount(inst)
    vaSchematicCount(inst~>prop)
)

procedure(vaSchematicParameterNames(inst cdf)
    let((names labelSet)
        names = nil
        labelSet = if(cdf then cdf~>paramLabelSet else nil)
        when(stringp(labelSet)
            foreach(parameterName parseString(labelSet)
                names = vaSchematicAddParameterName(names cdf parameterName)
            )
        )
        foreach(
            parameterName
            list("model" "w" "Wfg" "l" "fingers" "nf" "m" "simM" "r" "c" "idc" "vdc" "acm" "acp")
            names = vaSchematicAddParameterName(names cdf parameterName)
        )
        when(vaSchematicPropertyCount(inst) <= 24
            foreach(prop inst~>prop
                when(vaSchematicMeaningful(prop~>value)
                    names = vaSchematicAddParameterName(names cdf prop~>name)
                )
            )
        )
        names
    )
)

procedure(vaSchematicParametersJson(inst)
    let((cdf items separator param)
        cdf = cdfGetInstCDF(inst)
        items = ""
        separator = ""
        foreach(parameterName vaSchematicParameterNames(inst cdf)
            param = vaSchematicFindParameter(cdf parameterName)
            when(param
                items = strcat(
                    items
                    separator
                    vaSchematicJsonString(parameterName)
                    ":"
                    vaSchematicJsonValue(vaSchematicParameterValue(param))
                )
                separator = ","
            )
        )
        strcat("{" items "}")
    )
)

procedure(vaSchematicInstanceJson(inst)
    let((master xy x y)
        master = inst~>master
        xy = inst~>xy
        x = if(listp(xy) then car(xy) else nil)
        y = if(listp(xy) then cadr(xy) else nil)
        sprintf(
            nil
            "{\"name\":%s,\"master\":{\"library\":%s,\"cell\":%s,\"view\":%s},\"placement\":{\"x\":%s,\"y\":%s,\"orientation\":%s},\"parameters\":%s}"
            vaSchematicJsonString(inst~>name)
            vaSchematicJsonString(if(master then master~>libName else ""))
            vaSchematicJsonString(if(master then master~>cellName else ""))
            vaSchematicJsonString(if(master then master~>viewName else ""))
            vaSchematicJsonValue(x)
            vaSchematicJsonValue(y)
            vaSchematicJsonValue(inst~>orient)
            vaSchematicParametersJson(inst)
        )
    )
)

procedure(vaSchematicInstancesJson(cv)
    let((items separator)
        items = ""
        separator = ""
        foreach(inst cv~>instances
            items = strcat(items separator vaSchematicInstanceJson(inst))
            separator = ","
        )
        strcat("[" items "]")
    )
)

procedure(vaSchematicTerminalJson(term)
    sprintf(
        nil
        "{\"name\":%s,\"direction\":%s,\"width\":%L}"
        vaSchematicJsonString(term~>name)
        vaSchematicJsonValue(term~>direction)
        vaSchematicWidth(term~>numBits)
    )
)

procedure(vaSchematicTerminalsJson(cv)
    let((items separator)
        items = ""
        separator = ""
        foreach(term cv~>terminals
            items = strcat(items separator vaSchematicTerminalJson(term))
            separator = ","
        )
        strcat("[" items "]")
    )
)

procedure(vaSchematicNetJson(net)
    sprintf(
        nil
        "{\"name\":%s,\"signalType\":%s,\"isGlobal\":%s,\"width\":%L}"
        vaSchematicJsonString(net~>name)
        vaSchematicJsonValue(net~>sigType)
        vaSchematicJsonBoolean(net~>isGlobal)
        vaSchematicWidth(net~>numBits)
    )
)

procedure(vaSchematicNetsJson(cv)
    let((items separator)
        items = ""
        separator = ""
        foreach(net cv~>nets
            items = strcat(items separator vaSchematicNetJson(net))
            separator = ","
        )
        strcat("[" items "]")
    )
)

procedure(vaSchematicInstTermConnectionJson(inst instTerm)
    let((net term)
        net = instTerm~>net
        term = instTerm~>term
        sprintf(
            nil
            "{\"net\":%s,\"endpoint\":{\"kind\":\"instance-terminal\",\"instance\":%s,\"terminal\":%s,\"direction\":%s,\"width\":%L}}"
            if(net then vaSchematicJsonString(net~>name) else "null")
            vaSchematicJsonString(inst~>name)
            vaSchematicJsonString(instTerm~>name)
            vaSchematicJsonValue(if(term then term~>direction else nil))
            vaSchematicWidth(instTerm~>numBits)
        )
    )
)

procedure(vaSchematicTopTermConnectionJson(term)
    let((net)
        net = term~>net
        sprintf(
            nil
            "{\"net\":%s,\"endpoint\":{\"kind\":\"top-terminal\",\"terminal\":%s,\"direction\":%s,\"width\":%L}}"
            if(net then vaSchematicJsonString(net~>name) else "null")
            vaSchematicJsonString(term~>name)
            vaSchematicJsonValue(term~>direction)
            vaSchematicWidth(term~>numBits)
        )
    )
)

procedure(vaSchematicConnectionsJson(cv)
    let((items separator)
        items = ""
        separator = ""
        foreach(inst cv~>instances
            foreach(instTerm inst~>instTerms
                items = strcat(items separator vaSchematicInstTermConnectionJson(inst instTerm))
                separator = ","
            )
        )
        foreach(term cv~>terminals
            items = strcat(items separator vaSchematicTopTermConnectionJson(term))
            separator = ","
        )
        strcat("[" items "]")
    )
)

procedure(vaSchematicInstanceTerminalCount(cv)
    let((count)
        count = 0
        foreach(inst cv~>instances
            count = count + vaSchematicCount(inst~>instTerms)
        )
        count
    )
)

procedure(vaSchematicConnectedEndpointCount(cv)
    let((count)
        count = 0
        foreach(inst cv~>instances
            foreach(instTerm inst~>instTerms
                when(instTerm~>net count = count + 1)
            )
        )
        foreach(term cv~>terminals
            when(term~>net count = count + 1)
        )
        count
    )
)

procedure(vaSchematicReferencedMasterCount(cv)
    let((keys master key)
        keys = nil
        foreach(inst cv~>instances
            master = inst~>master
            when(master
                key = sprintf(nil "%s/%s/%s" master~>libName master~>cellName master~>viewName)
                unless(member(key keys) keys = cons(key keys))
            )
        )
        vaSchematicCount(keys)
    )
)

procedure(vaSchematicEmitOk(manifest resultPath)
    if(resultPath then
        vaSessionWriteResult(resultPath vaOkEnvelope(manifest))
    else
        vaPrintOk(manifest)
    )
)

procedure(vaSchematicEmitError(errorType message resultPath)
    if(resultPath then
        vaSessionWriteResult(resultPath vaErrorEnvelope(errorType message))
    else
        vaPrintError(errorType message)
    )
)

procedure(vaInspectSchematicInternal(library cell view resultPath)
    let((cv status statusText instanceCount terminalCount instanceTerminalCount netCount connectedCount totalEndpoints manifest)
        cv = dbOpenCellViewByType(library cell view "" "r")
        if(cv then
            status = schExtractStatus(cv)
            statusText = if(status then vaSchematicText(status) else "unknown")
            instanceCount = vaSchematicCount(cv~>instances)
            terminalCount = vaSchematicCount(cv~>terminals)
            instanceTerminalCount = vaSchematicInstanceTerminalCount(cv)
            netCount = vaSchematicCount(cv~>nets)
            connectedCount = vaSchematicConnectedEndpointCount(cv)
            totalEndpoints = instanceTerminalCount + terminalCount

            manifest = sprintf(
                nil
                "{\"schemaVersion\":\"0.1\",\"kind\":\"schematic-inspect\",\"generatedAt\":%s,\"target\":{\"library\":%s,\"cell\":%s,\"view\":%s},\"source\":{\"openMode\":\"r\",\"virtuosoVersion\":%s},\"connectivity\":{\"status\":%s},\"summary\":{\"instances\":%L,\"topTerminals\":%L,\"instanceTerminals\":%L,\"nets\":%L,\"connectedEndpoints\":%L,\"unconnectedEndpoints\":%L,\"referencedMasters\":%L},\"instances\":%s,\"terminals\":%s,\"nets\":%s,\"connections\":%s,\"references\":[],\"warnings\":[]}"
                vaSchematicJsonString(getCurrentTime())
                vaSchematicJsonString(library)
                vaSchematicJsonString(cell)
                vaSchematicJsonString(view)
                vaSchematicJsonString(getVersion(t))
                vaSchematicJsonString(statusText)
                instanceCount
                terminalCount
                instanceTerminalCount
                netCount
                connectedCount
                totalEndpoints - connectedCount
                vaSchematicReferencedMasterCount(cv)
                vaSchematicInstancesJson(cv)
                vaSchematicTerminalsJson(cv)
                vaSchematicNetsJson(cv)
                vaSchematicConnectionsJson(cv)
            )

            dbClose(cv)
            vaSchematicEmitOk(manifest resultPath)
        else
            vaSchematicEmitError(
                "CELLVIEW_OPEN_FAILED"
                sprintf(nil "Could not open %s/%s/%s in read-only mode." library cell view)
                resultPath
            )
        )
    )
)

procedure(vaInspectSchematic(library cell view)
    vaInspectSchematicInternal(library cell view nil)
)

procedure(vaSessionInspectSchematic(library cell view resultPath)
    vaInspectSchematicInternal(library cell view resultPath)
)
